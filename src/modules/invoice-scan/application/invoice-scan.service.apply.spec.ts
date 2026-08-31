import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Aquí los modelos van
// mockeados. Mismo patrón que `sales/application/orders.service.checkout.spec.ts`.
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

/**
 * Aplicar una factura es la operación irreversible del módulo: crea productos,
 * mueve inventario, genera cuenta por pagar y postea asientos.
 *
 * Lo que se protege aquí:
 *  1. que la mercancía vaya por el circuito de compra y solo lo no inventariable
 *     acabe en gastos;
 *  2. que una factura mal formada se rechace ENTERA y con un mensaje concreto,
 *     en vez de aplicarse a medias;
 *  3. que un reintento no duplique lo ya creado.
 *
 * El servicio se instancia directamente con dependencias mockeadas. El
 * constructor es: (scans, extractor, matching, storage, businesses, suppliers,
 * products, purchasing, finance).
 */
describe('InvoiceScanService.apply', () => {
  const sedeId = new Types.ObjectId().toString();
  const supplierId = new Types.ObjectId();
  const productId = new Types.ObjectId();
  const categoryId = new Types.ObjectId();
  const ctx = { businessId: 'b1', dbName: 'biz_b1' };

  const user = { userId: 'u1', email: 'due@negocio.com' } as unknown as JwtUser;

  /** Factura del ejemplo: dos productos y un flete. */
  function draft() {
    return {
      supplier: { name: 'Distribuidora El Sol', docNumber: '900123456', docType: 'NIT' },
      invoice: { number: 'FV-4821', issueDate: '2026-08-30', paymentTerms: 'credito' },
      lines: [
        { description: 'Gaseosa 350 ml', qty: 24, unitCost: 1200, ivaRate: 19, lineTotal: 28800 },
        { description: 'Arroz 500 g', qty: 10, unitCost: 2500, ivaRate: 5, lineTotal: 25000 },
        { description: 'Transporte', lineTotal: 15000 },
      ],
      totals: { total: 68800 },
    };
  }

  function makeScan(overrides: Record<string, unknown> = {}) {
    return {
      id: new Types.ObjectId().toString(),
      _id: new Types.ObjectId(),
      status: 'extracted',
      draft: draft(),
      supplierId,
      sedeId: new Types.ObjectId(sedeId),
      lineDecisions: [
        { lineIndex: 0, target: 'inventory', productId, createProduct: false },
        {
          lineIndex: 1,
          target: 'inventory',
          createProduct: true,
          newProduct: {
            sku: 'ARROZ-500',
            name: 'Arroz Diana 500 g',
            unit: 'und',
            salePrice: 3500,
          },
        },
        { lineIndex: 2, target: 'expense', categoryId, createProduct: false },
      ],
      appliedTo: { expenseIds: [], createdProductIds: [] },
      history: [],
      pages: [],
      save: vi.fn().mockResolvedValue(undefined),
      markModified: vi.fn(),
      ...overrides,
    };
  }

  function makeDeps(scan: ReturnType<typeof makeScan>) {
    return {
      scans: { findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(scan) }) },
      extractor: { model: 'test', enabled: true, extract: vi.fn() },
      matching: { rememberAlias: vi.fn().mockResolvedValue(undefined) },
      storage: { upload: vi.fn(), remove: vi.fn() },
      businesses: { consumeScan: vi.fn() },
      suppliers: {
        findByDocNumber: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        getOrFail: vi.fn().mockResolvedValue({ name: 'Distribuidora El Sol' }),
      },
      products: {
        create: vi.fn().mockResolvedValue({ id: new Types.ObjectId().toString() }),
      },
      purchasing: {
        create: vi.fn().mockResolvedValue({
          id: 'po1',
          _id: new Types.ObjectId(),
        }),
        receive: vi.fn().mockResolvedValue(undefined),
      },
      finance: {
        createExpense: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      },
    };
  }

  function makeService(deps: ReturnType<typeof makeDeps>) {
    return new InvoiceScanService(
      deps.scans as never,
      deps.extractor as never,
      deps.matching as never,
      deps.storage as never,
      deps.businesses as never,
      deps.suppliers as never,
      deps.products as never,
      deps.purchasing as never,
      deps.finance as never,
    );
  }

  let scan: ReturnType<typeof makeScan>;
  let deps: ReturnType<typeof makeDeps>;
  let service: InvoiceScanService;

  beforeEach(() => {
    scan = makeScan();
    deps = makeDeps(scan);
    service = makeService(deps);
  });

  it('la mercancía va por la orden de compra y el flete a gastos', async () => {
    await TenantContext.run(ctx, () => service.apply(scan.id, user));

    // Compra: solo las dos líneas de mercancía, con su código de impuesto.
    const order = deps.purchasing.create.mock.calls[0][0] as {
      sedeId: string;
      lines: { description: string; qty: number; unitCost: number; taxCode: string }[];
    };
    expect(order.sedeId).toBe(sedeId);
    expect(order.lines).toHaveLength(2);
    expect(order.lines[0]).toMatchObject({
      description: 'Gaseosa 350 ml',
      qty: 24,
      unitCost: 1200,
      taxCode: 'IVA_19',
    });
    expect(order.lines[1]?.taxCode).toBe('IVA_5');

    // Recepción: es lo que mete el stock, crea la CxP y postea el asiento.
    const receipt = deps.purchasing.receive.mock.calls[0][1] as {
      generatePayable: boolean;
      docNumber: string;
      lines: { lineIndex: number; qty: number }[];
    };
    expect(receipt.generatePayable).toBe(true);
    expect(receipt.docNumber).toBe('FV-4821');
    expect(receipt.lines).toEqual([
      { lineIndex: 0, qty: 24 },
      { lineIndex: 1, qty: 10 },
    ]);

    // Gasto: solo el transporte.
    expect(deps.finance.createExpense).toHaveBeenCalledTimes(1);
    const expense = deps.finance.createExpense.mock.calls[0][0] as {
      concept: string;
      amount: number;
      status: string;
    };
    expect(expense).toMatchObject({
      concept: 'Transporte',
      amount: 15000,
      status: 'payable',
    });

    expect(scan.status).toBe('applied');
  });

  it('crea el producto nuevo con lo que se completó en la revisión', async () => {
    await TenantContext.run(ctx, () => service.apply(scan.id, user));

    expect(deps.products.create).toHaveBeenCalledTimes(1);
    const created = deps.products.create.mock.calls[0][0] as {
      sku: string;
      name: string;
      cost: number;
      salePrice: number;
    };
    // El nombre y el precio de venta los puso la persona; el costo, la factura.
    expect(created).toMatchObject({
      sku: 'ARROZ-500',
      name: 'Arroz Diana 500 g',
      salePrice: 3500,
      cost: 2500,
    });
    expect(scan.appliedTo.createdProductIds).toHaveLength(1);
  });

  it('pide el SKU cuando el producto es nuevo y la factura no trae código', async () => {
    // Sin código en la factura ni ficha completada no hay SKU: antes se
    // generaba uno tipo FAC-XYZ que quedaba para siempre en el catálogo.
    scan.lineDecisions[1].newProduct = undefined;

    await expect(
      TenantContext.run(ctx, () => service.apply(scan.id, user)),
    ).rejects.toThrow(/SKU/);
    expect(deps.products.create).not.toHaveBeenCalled();
    expect(deps.purchasing.create).not.toHaveBeenCalled();
  });

  it('usa el código de la factura como SKU cuando viene', async () => {
    scan.lineDecisions[1].newProduct = undefined;
    scan.draft.lines[1].code = 'ARZ-500';

    await TenantContext.run(ctx, () => service.apply(scan.id, user));

    const created = deps.products.create.mock.calls[0][0] as { sku: string };
    expect(created.sku).toBe('ARZ-500');
  });

  it('aprende el alias para que la próxima factura empareje sola', async () => {
    await TenantContext.run(ctx, () => service.apply(scan.id, user));
    expect(deps.matching.rememberAlias).toHaveBeenCalledWith(
      supplierId.toString(),
      'Gaseosa 350 ml',
      productId.toString(),
    );
  });

  it('rechaza la factura entera si una cantidad no es entera, sin tocar nada', async () => {
    scan.draft.lines[0].qty = 2.5;

    await expect(
      TenantContext.run(ctx, () => service.apply(scan.id, user)),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(deps.purchasing.create).not.toHaveBeenCalled();
    expect(deps.products.create).not.toHaveBeenCalled();
    expect(deps.finance.createExpense).not.toHaveBeenCalled();
  });

  it('exige categoría en la línea de gasto antes de aplicar nada', async () => {
    scan.lineDecisions[2].categoryId = undefined;

    await expect(
      TenantContext.run(ctx, () => service.apply(scan.id, user)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.purchasing.create).not.toHaveBeenCalled();
  });

  it('exige sede: sin ella la mercancía no sabría dónde entrar', async () => {
    scan.sedeId = undefined;
    await expect(
      TenantContext.run(ctx, () => service.apply(scan.id, user)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un reintento no vuelve a crear la orden ni los gastos', async () => {
    // Estado de un intento anterior que murió después de crear la compra.
    scan.appliedTo.purchaseOrderId = new Types.ObjectId();
    scan.appliedTo.supplierId = supplierId;
    scan.lineDecisions[1].productId = new Types.ObjectId();
    scan.lineDecisions[1].createProduct = false;

    await TenantContext.run(ctx, () => service.apply(scan.id, user));

    expect(deps.purchasing.create).not.toHaveBeenCalled();
    expect(deps.purchasing.receive).not.toHaveBeenCalled();
    expect(deps.products.create).not.toHaveBeenCalled();
    // Los gastos sí faltaban: esos se crean ahora.
    expect(deps.finance.createExpense).toHaveBeenCalledTimes(1);
    expect(scan.status).toBe('applied');
  });

  it('una factura ya aplicada se devuelve tal cual, sin repetir nada', async () => {
    scan.status = 'applied';
    await TenantContext.run(ctx, () => service.apply(scan.id, user));
    expect(deps.purchasing.create).not.toHaveBeenCalled();
    expect(deps.finance.createExpense).not.toHaveBeenCalled();
  });

  it('crea el proveedor cuando la factura trae uno que no existe', async () => {
    scan.supplierId = undefined;
    deps.suppliers.create.mockResolvedValue({ id: supplierId.toString() });

    await TenantContext.run(ctx, () => service.apply(scan.id, user));

    expect(deps.suppliers.findByDocNumber).toHaveBeenCalledWith('NIT', '900123456');
    const created = deps.suppliers.create.mock.calls[0][0] as {
      name: string;
      docNumber: string;
    };
    expect(created).toMatchObject({
      name: 'Distribuidora El Sol',
      docNumber: '900123456',
    });
  });

  it('paga de contado cuando la factura lo dice: sin cuenta por pagar', async () => {
    scan.draft.invoice.paymentTerms = 'contado';

    await TenantContext.run(ctx, () => service.apply(scan.id, user));

    const receipt = deps.purchasing.receive.mock.calls[0][1] as {
      generatePayable: boolean;
    };
    expect(receipt.generatePayable).toBe(false);
    const expense = deps.finance.createExpense.mock.calls[0][0] as { status: string };
    expect(expense.status).toBe('paid');
  });
});
