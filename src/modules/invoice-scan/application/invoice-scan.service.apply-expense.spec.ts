import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// Mismo patrón que `invoice-scan.service.apply.spec.ts`: SWC y los @Prop().
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import { InvoiceScanService } from './invoice-scan.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import type { ApplyAsExpenseDto } from './dto/apply-as-expense.dto';

/**
 * Aplicar la factura completa como gasto.
 *
 * Lo que se protege:
 *  1. que no toque inventario ni compras: es un gasto de punta a punta;
 *  2. que base, IVA y retenciones lleguen separados, porque van a cuentas
 *     distintas;
 *  3. que a crédito quede la cuenta por pagar por el NETO, que es lo que de
 *     verdad se le debe al proveedor;
 *  4. que se rechace entera y sin crear nada si faltan datos, y que un
 *     reintento no duplique.
 */
describe('InvoiceScanService.applyAsExpense', () => {
  const sedeId = new Types.ObjectId().toString();
  const categoryId = new Types.ObjectId().toString();
  const supplierId = new Types.ObjectId();
  const ctx = { businessId: 'b1', dbName: 'biz_b1' };
  const user = { userId: 'u1', email: 'due@negocio.com' } as unknown as JwtUser;

  function makeScan(overrides: Record<string, unknown> = {}) {
    return {
      id: new Types.ObjectId().toString(),
      _id: new Types.ObjectId(),
      status: 'extracted',
      draft: {
        supplier: { name: 'Mantenimientos Andinos', docNumber: '901234567', docType: 'NIT' },
        invoice: { number: 'FE-120', issueDate: '2026-09-01', paymentTerms: 'credito' },
        lines: [
          { description: 'Mantenimiento nevera', lineTotal: 80000 },
          { description: 'Repuesto compresor', lineTotal: 20000 },
        ],
        totals: { subtotal: 100000, iva: 19000, total: 119000 },
      },
      supplierId,
      lineDecisions: [],
      appliedTo: { expenseIds: [] as Types.ObjectId[], createdProductIds: [] },
      history: [] as unknown[],
      pages: [],
      save: vi.fn().mockResolvedValue(undefined),
      markModified: vi.fn(),
      ...overrides,
    } as any;
  }

  function makeDeps(scan: ReturnType<typeof makeScan>) {
    return {
      scans: { findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(scan) }) },
      suppliers: {
        findByDocNumber: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: supplierId.toString() }),
        getOrFail: vi.fn().mockResolvedValue({ name: 'Mantenimientos Andinos' }),
      },
      products: { create: vi.fn() },
      purchasing: { create: vi.fn(), receive: vi.fn() },
      finance: {
        createExpense: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
        createPayable: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      },
    };
  }

  /** El constructor es: (scans, extractor, matching, storage, businesses, suppliers, products, purchasing, finance). */
  function makeService(deps: ReturnType<typeof makeDeps>) {
    return new InvoiceScanService(
      deps.scans as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      deps.suppliers as never,
      deps.products as never,
      deps.purchasing as never,
      deps.finance as never,
    );
  }

  function dto(overrides: Partial<ApplyAsExpenseDto> = {}): ApplyAsExpenseDto {
    return {
      sedeId,
      categoryId,
      concept: 'Factura FE-120 · Mantenimientos Andinos',
      date: '2026-09-01',
      amount: 100000,
      taxAmount: 19000,
      withholdingAmount: 4000,
      status: 'payable',
      dueDate: '2026-10-01',
      ...overrides,
    };
  }

  let scan: ReturnType<typeof makeScan>;
  let deps: ReturnType<typeof makeDeps>;
  let service: InvoiceScanService;

  const run = (body: ApplyAsExpenseDto) =>
    TenantContext.run(ctx as never, () => service.applyAsExpense(scan.id, body, user));

  beforeEach(() => {
    scan = makeScan();
    deps = makeDeps(scan);
    service = makeService(deps);
  });

  it('registra un solo gasto con base, IVA y retenciones, sin tocar inventario', async () => {
    await run(dto());

    expect(deps.purchasing.create).not.toHaveBeenCalled();
    expect(deps.products.create).not.toHaveBeenCalled();
    expect(deps.finance.createExpense).toHaveBeenCalledTimes(1);
    expect(deps.finance.createExpense.mock.calls[0]?.[0]).toMatchObject({
      sedeId,
      categoryId,
      amount: 100000,
      taxAmount: 19000,
      withholdingAmount: 4000,
      status: 'payable',
      supplierId: supplierId.toString(),
      supplierName: 'Mantenimientos Andinos',
    });
    expect(scan.status).toBe('applied');
    expect(scan.sedeId.toString()).toBe(sedeId);
  });

  it('a crédito deja la cuenta por pagar por el neto, con número y vencimiento', async () => {
    await run(dto());

    expect(deps.finance.createPayable).toHaveBeenCalledTimes(1);
    expect(deps.finance.createPayable.mock.calls[0]?.[0]).toMatchObject({
      amount: 115000, // 100.000 + 19.000 − 4.000 retenidos
      docNumber: 'FE-120',
      issueDate: '2026-09-01',
      dueDate: '2026-10-01',
    });
    expect(scan.appliedTo.payableId).toBeDefined();
  });

  it('de contado registra el medio de pago y no crea cuenta por pagar', async () => {
    await run(dto({ status: 'paid', paymentMethod: 'transfer', dueDate: undefined }));

    expect(deps.finance.createExpense.mock.calls[0]?.[0]).toMatchObject({
      status: 'paid',
      paymentMethod: 'transfer',
    });
    expect(deps.finance.createPayable).not.toHaveBeenCalled();
  });

  it('de contado sin medio de pago se rechaza sin crear nada', async () => {
    await expect(run(dto({ status: 'paid' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(deps.finance.createExpense).not.toHaveBeenCalled();
    expect(scan.save).not.toHaveBeenCalled();
  });

  it('rechaza retenciones mayores que el total', async () => {
    await expect(run(dto({ withholdingAmount: 200000 }))).rejects.toThrow(
      /retenciones/,
    );
    expect(deps.finance.createExpense).not.toHaveBeenCalled();
  });

  it('rechaza un gasto sin valor', async () => {
    await expect(run(dto({ amount: 0, taxAmount: 0 }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rechaza un vencimiento anterior a la fecha de la factura', async () => {
    await expect(run(dto({ dueDate: '2026-08-01' }))).rejects.toThrow(
      /vencimiento/,
    );
    expect(deps.finance.createExpense).not.toHaveBeenCalled();
  });

  it('crea el proveedor cuando la factura trae uno que no existe', async () => {
    scan.supplierId = undefined;

    await run(dto());

    expect(deps.suppliers.findByDocNumber).toHaveBeenCalledWith('NIT', '901234567');
    expect(deps.suppliers.create).toHaveBeenCalledTimes(1);
  });

  it('un reintento no vuelve a crear el gasto; solo lo que faltaba', async () => {
    // Intento anterior que murió después de crear el gasto.
    scan.appliedTo.supplierId = supplierId;
    scan.appliedTo.expenseIds = [new Types.ObjectId()];

    await run(dto());

    expect(deps.finance.createExpense).not.toHaveBeenCalled();
    expect(deps.finance.createPayable).toHaveBeenCalledTimes(1);
    expect(scan.status).toBe('applied');
  });

  it('una factura ya aplicada se devuelve tal cual', async () => {
    scan.status = 'applied';

    await run(dto());

    expect(deps.finance.createExpense).not.toHaveBeenCalled();
    expect(deps.finance.createPayable).not.toHaveBeenCalled();
  });
});
