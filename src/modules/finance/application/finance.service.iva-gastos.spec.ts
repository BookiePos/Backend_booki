import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';

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

import { FinanceService } from './finance.service';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { LedgerService, type PostEntryInput } from '../../core-ledger/application/ledger.service';
import { ACC } from '../../core-ledger/domain/ledger.constants';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import type { BusinessType } from '../../control/domain/control.constants';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * El IVA pagado tiene que contar igual en el libro y en el P&L.
 *
 * - Gastos: el responsable de IVA lo lleva a la 2408 (descontable, art. 488 ET)
 *   y el gasto queda en la base; el restaurante que causa INC o el no
 *   responsable no lo descuenta (arts. 437 par. 3 y 512-1 ET): es mayor valor
 *   del gasto, en el libro y en el P&L.
 * - Compras: la recepción ya debita la 2408 por el IVA descontable; el P&L lo
 *   lee de ahí (la recepción no guarda su IVA en otro lado).
 *
 * Se usa el posteo real sobre un libro en memoria, y el P&L real sobre ese
 * mismo libro: si coinciden aquí, coinciden en la vida real.
 *
 * Constructor (orden): categories, expenses, payables, recurring, receivables,
 * accounts, movements, budgets, sales, products, runs, caja, customers,
 * ledgerPosting, treasuryPosting, params, sedes, businesses, ledger.
 */
describe('FinanceService · IVA de gastos y compras, libro y P&L coinciden', () => {
  const SEDE = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'duena@bookipos.local',
    role: 'owner',
    sedeIds: [SEDE.toString()],
    permissions: [],
  } as unknown as JwtUser;

  function q(docs: unknown) {
    return {
      select: () => ({ exec: () => Promise.resolve(docs) }),
      exec: () => Promise.resolve(docs),
    };
  }

  function build(tipoNegocio: BusinessType, responsabilidadFiscal: string) {
    const libro: PostEntryInput[] = [];
    const posting = new LedgerPostingService({
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn((input: PostEntryInput) => {
        libro.push(input);
        return Promise.resolve({});
      }),
    } as never, { registrar: vi.fn() } as never);
    // Lo justo de `find` para la consulta del IVA de compras sobre el libro.
    const entries = {
      find: vi.fn((f: any) =>
        q(
          libro.filter(
            (e) =>
              e.date >= f.date.$gte &&
              e.date <= f.date.$lte &&
              f.sourceType.$in.includes(e.sourceType) &&
              e.lines.some((l) => l.accountCode === f['lines.accountCode']),
          ),
        ),
      ),
    };
    const ledger = new LedgerService({} as never, entries as never, { findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({ seq: 1 }) })) } as never);

    const gastos: any[] = [];
    const expenses = {
      create: vi.fn((doc: any) => {
        const saved = { ...doc, _id: new Types.ObjectId() };
        gastos.push(saved);
        return Promise.resolve(saved);
      }),
      find: vi.fn(() => q(gastos)),
    };
    const categories = {
      findById: vi.fn(() =>
        q({ _id: new Types.ObjectId(), name: 'Servicios', kind: 'expense' }),
      ),
    };
    const sede = { _id: SEDE, responsabilidadFiscal };
    const sedes = {
      find: vi.fn(() => q([sede])),
      findById: vi.fn(() => q(sede)),
    };
    const args: unknown[] = Array.from({ length: 19 }, () => ({}));
    args[0] = categories;
    args[1] = expenses;
    args[8] = { find: vi.fn(() => q([])) }; // ventas
    args[10] = { find: vi.fn(() => q([])) }; // nómina
    args[13] = posting;
    args[14] = { post: vi.fn(), reverse: vi.fn() };
    args[16] = sedes;
    args[17] = { findById: async () => null };
    args[18] = ledger;
    const service = new (FinanceService as any)(...args) as FinanceService;
    const run = <T>(fn: () => Promise<T>) =>
      TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', tipoNegocio }, fn);
    const debito = (code: string) =>
      libro
        .flatMap((e) => e.lines)
        .filter((l) => l.accountCode === code)
        .reduce((a, l) => a + (l.debit ?? 0) - (l.credit ?? 0), 0);
    return { service, posting, libro, run, debito };
  }

  const gasto = {
    sedeId: SEDE.toString(),
    categoryId: new Types.ObjectId().toString(),
    concept: 'Mantenimiento',
    amount: 100_000,
    taxAmount: 19_000,
    date: '2026-10-10',
    status: 'paid',
    paymentMethod: 'cash',
  };

  const pl = (ctx: ReturnType<typeof build>) =>
    ctx.run(() =>
      ctx.service.profitAndLoss(user, '2026-10-01', '2026-10-31', SEDE.toString()),
    );

  it('responsable de IVA: el gasto va a la base y el IVA a la 2408, en el libro y en el P&L', async () => {
    const ctx = build('retail', 'responsable_iva');
    await ctx.run(() => ctx.service.createExpense(gasto as never, user));

    expect(ctx.debito(ACC.GASTOS_DIVERSOS)).toBe(100_000);
    expect(ctx.debito(ACC.IVA_POR_PAGAR)).toBe(19_000);

    const r = await pl(ctx);
    expect(r.gastosTotal).toBe(ctx.debito(ACC.GASTOS_DIVERSOS));
    expect(r.ivaDescontable).toBe(ctx.debito(ACC.IVA_POR_PAGAR));
  });

  it('restaurante con INC: el IVA es gasto, la 2408 no se toca, y el P&L lo muestra igual', async () => {
    const ctx = build('restaurante', 'responsable_iva');
    await ctx.run(() => ctx.service.createExpense(gasto as never, user));

    expect(ctx.debito(ACC.GASTOS_DIVERSOS)).toBe(119_000);
    expect(ctx.debito(ACC.IVA_POR_PAGAR)).toBe(0);

    const r = await pl(ctx);
    expect(r.gastosTotal).toBe(119_000);
    expect(r.ivaDescontable).toBe(0);
    expect(r.ivaPorPagar).toBe(0);
  });

  it('no responsable de IVA: tampoco descuenta; el IVA es mayor valor del gasto', async () => {
    const ctx = build('retail', 'no_responsable_iva');
    await ctx.run(() => ctx.service.createExpense(gasto as never, user));

    const r = await pl(ctx);
    expect(ctx.debito(ACC.GASTOS_DIVERSOS)).toBe(119_000);
    expect(r.gastosTotal).toBe(119_000);
    expect(r.ivaDescontable).toBe(0);
  });

  it('responsable compra 1.000.000 + 190.000: el P&L cuenta el IVA descontable de la compra', async () => {
    const ctx = build('retail', 'responsable_iva');
    await ctx.posting.postPurchaseReceipt({
      receiptId: 'r1',
      date: '2026-10-12',
      sedeId: SEDE.toString(),
      amount: 1_000_000,
      ivaDescontable: 190_000,
      onCredit: true,
      number: 'OC-000001',
    });

    const r = await pl(ctx);
    expect(ctx.debito(ACC.IVA_POR_PAGAR)).toBe(190_000);
    expect(r.ivaDescontable).toBe(190_000);
    expect(r.ivaPorPagar).toBe(-190_000);
  });

  it('compra y gasto juntos: el descontable del P&L es el débito de la 2408 del libro', async () => {
    const ctx = build('retail', 'responsable_iva');
    await ctx.run(() => ctx.service.createExpense(gasto as never, user));
    await ctx.posting.postPurchaseReceipt({
      receiptId: 'r1',
      date: '2026-10-12',
      sedeId: SEDE.toString(),
      amount: 1_000_000,
      ivaDescontable: 190_000,
      onCredit: true,
      number: 'OC-000001',
    });

    const r = await pl(ctx);
    expect(r.ivaDescontable).toBe(209_000);
    expect(r.ivaDescontable).toBe(ctx.debito(ACC.IVA_POR_PAGAR));
  });

  it('la reversa de una recepción resta su IVA; otra sede o fuera del rango no cuentan', async () => {
    const ctx = build('retail', 'responsable_iva');
    const otra = new Types.ObjectId().toString();
    const recepcion = (sedeId: string, date: string, iva: number, sourceType = 'purchase_receipt') =>
      ctx.libro.push({
        date,
        sourceType,
        lines: [
          { accountCode: ACC.INVENTARIO, debit: iva * 10, sedeId },
          { accountCode: ACC.IVA_POR_PAGAR, debit: iva, sedeId },
          { accountCode: ACC.PROVEEDORES, credit: iva * 11, sedeId },
        ],
      });
    recepcion(SEDE.toString(), '2026-10-05', 190_000);
    recepcion(otra, '2026-10-05', 50_000);
    recepcion(SEDE.toString(), '2026-11-01', 7_000);
    // Contra-asiento de una recepción del mismo mes: lados intercambiados.
    ctx.libro.push({
      date: '2026-10-20',
      sourceType: 'reversal:purchase_receipt',
      lines: [
        { accountCode: ACC.PROVEEDORES, debit: 11_900, sedeId: SEDE.toString() },
        { accountCode: ACC.IVA_POR_PAGAR, credit: 1_900, sedeId: SEDE.toString() },
        { accountCode: ACC.INVENTARIO, credit: 10_000, sedeId: SEDE.toString() },
      ],
    });

    const r = await pl(ctx);
    expect(r.ivaDescontable).toBe(188_100);
  });
});
