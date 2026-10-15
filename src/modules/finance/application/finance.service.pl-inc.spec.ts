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
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * P&L: el IVA por pagar no puede incluir el INC del restaurante, y el INC sale
 * en su propia línea, sin restarle IVA descontable (el INC no lo admite).
 *
 * Constructor (orden): categories, expenses, payables, recurring, receivables,
 * accounts, movements, budgets, sales, products, runs, caja, customers,
 * ledgerPosting, treasuryPosting, params, sedes, businesses, ledger.
 */
describe('FinanceService.profitAndLoss · INC aparte del IVA', () => {
  const SEDE = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'duena@bookipos.local',
    role: 'owner',
    sedeIds: [SEDE.toString()],
    permissions: [],
  } as unknown as JwtUser;

  function q(docs: unknown[]) {
    return {
      select: () => ({ exec: () => Promise.resolve(docs) }),
      exec: () => Promise.resolve(docs),
    };
  }

  /** Libro sin recepciones de compra: el descontable es solo el de los gastos. */
  const sinCompras = { ivaDescontableDeCompras: async () => 0 };

  function sedesModel(docs: unknown[]) {
    return {
      find: vi.fn(() => q(docs)),
      findById: vi.fn(() => q((docs[0] ?? null) as never)),
    };
  }

  /** P&L de octubre con una venta y un gasto con IVA de 300, bajo un giro dado. */
  async function plCon(
    tipoNegocio: 'restaurante' | 'retail',
    sedes: unknown[],
    lineas: unknown[],
    taxTotal: number,
  ) {
    const sales = {
      find: vi.fn(() =>
        q([{ taxableBase: 10_000, taxTotal, lines: lineas, components: [] }]),
      ),
    };
    const expenses = {
      find: vi.fn(() => q([{ amount: 1_300, taxAmount: 300, sedeId: SEDE }])),
    };
    const args: unknown[] = Array.from({ length: 16 }, () => ({}));
    args[1] = expenses;
    args[8] = sales;
    args[10] = { find: vi.fn(() => q([])) };
    const service = new (FinanceService as any)(
      ...args,
      sedesModel(sedes),
      { findById: async () => null },
      sinCompras,
    ) as FinanceService;
    return TenantContext.run(
      { businessId: 'b1', dbName: 'biz_b1', tipoNegocio },
      () => service.profitAndLoss(user, '2026-10-01', '2026-10-31', SEDE.toString()),
    );
  }

  it('restaurante (INC): sin IVA descontable, ivaPorPagar no queda «a favor» (arts. 437 y 488 ET)', async () => {
    const pl = await plCon(
      'restaurante',
      [{ _id: SEDE, responsabilidadFiscal: 'responsable_iva' }],
      [{ taxKind: 'inc', taxAmount: 800 }],
      800,
    );
    expect(pl.ivaDescontable).toBe(0);
    expect(pl.ivaPorPagar).toBe(0);
    expect(pl.incPorPagar).toBe(800);
  });

  it('no responsable de IVA: sin IVA descontable (art. 437 par. 3 ET)', async () => {
    const pl = await plCon(
      'retail',
      [{ _id: SEDE, responsabilidadFiscal: 'no_responsable_iva' }],
      [{ taxKind: 'ninguno', taxAmount: 0 }],
      0,
    );
    expect(pl.ivaDescontable).toBe(0);
    expect(pl.ivaPorPagar).toBe(0);
  });

  it('responsable de IVA en retail: el IVA de los gastos sí descuenta', async () => {
    const pl = await plCon(
      'retail',
      [{ _id: SEDE, responsabilidadFiscal: 'responsable_iva' }],
      [{ taxKind: 'iva', taxAmount: 1_900 }],
      1_900,
    );
    expect(pl.ivaDescontable).toBe(300);
    expect(pl.ivaPorPagar).toBe(1_600);
  });

  it('ivaPorPagar solo con IVA; el INC va en incGenerado/incPorPagar', async () => {
    const sales = {
      find: vi.fn(() =>
        q([
          {
            taxableBase: 27_778,
            taxTotal: 2_222,
            lines: [{ taxKind: 'inc', taxAmount: 2_222 }],
            components: [],
          },
          {
            taxableBase: 10_000,
            taxTotal: 1_900,
            lines: [{ taxKind: 'iva', taxAmount: 1_900 }],
            components: [],
          },
        ]),
      ),
    };
    const expenses = { find: vi.fn(() => q([{ amount: 1_300, taxAmount: 300 }])) };
    const runs = { find: vi.fn(() => q([])) };

    const service = new FinanceService(
      {} as never,
      expenses as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sales as never,
      {} as never,
      runs as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sedesModel([]) as never,
      { findById: async () => null } as never,
      sinCompras as never,
    );

    const pl = await service.profitAndLoss(
      user,
      '2026-10-01',
      '2026-10-31',
      SEDE.toString(),
    );

    expect(pl.ivaGenerado).toBe(1_900);
    expect(pl.ivaDescontable).toBe(300);
    expect(pl.ivaPorPagar).toBe(1_600);
    expect(pl.incGenerado).toBe(2_222);
    expect(pl.incPorPagar).toBe(2_222);
  });
});
