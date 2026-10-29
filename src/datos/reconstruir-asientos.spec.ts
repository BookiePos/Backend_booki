import { describe, it, expect, vi } from 'vitest';

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

import {
  cuentaDeGasto,
  insumoVenta,
  recepcionesDeOrden,
  reconstruirAsientos,
  type FuentesReconstruccion,
  type GastoGuardado,
  type OrdenGuardada,
  type PendienteAbierto,
  type VentaGuardada,
} from './reconstruir-asientos';
import { FinanceService } from '../modules/finance/application/finance.service';
import { CATEGORY_KINDS } from '../modules/finance/domain/finance.constants';

/**
 * Herramienta de reconstrucción del libro (checklist 1.13). Lo que importa:
 * que el asiento reconstruido salga igual al que habría hecho el flujo
 * original, que en seco no escriba nada, y que no invente lo que no puede
 * saber (el medio de pago de una compra de contado).
 */
describe('reconstruir asientos faltantes', () => {
  const SEDE = 'sede-1';

  const venta = (over: Partial<VentaGuardada> = {}): VentaGuardada => ({
    id: 'v1',
    saleNumber: 'FV-000001',
    sedeId: SEDE,
    status: 'completed',
    total: 119_000,
    deliveryFee: 5_000,
    tip: 11_900,
    paymentMethod: 'cash',
    lines: [
      { taxKind: 'iva', taxAmount: 19_000 },
      { taxKind: 'inc', taxAmount: 0 },
    ],
    components: [{ cost: 40_000 }, { cost: 2_500 }],
    createdAt: new Date('2026-10-14T03:00:00Z'), // 13-oct en Colombia
    ...over,
  });

  const gasto = (over: Partial<GastoGuardado> = {}): GastoGuardado => ({
    id: 'g1',
    sedeId: SEDE,
    categoryId: 'cat-1',
    concept: 'Internet',
    amount: 100_000,
    taxAmount: 19_000,
    date: '2026-10-10',
    status: 'paid',
    paymentMethod: 'transfer',
    ...over,
  });

  const orden = (over: Partial<OrdenGuardada> = {}): OrdenGuardada => ({
    id: 'oc1',
    number: 'OC-000001',
    sedeId: SEDE,
    lines: [{ qty: 3, unitCost: 10_000, taxAmount: 5_700 }],
    receipts: [
      { id: 'r1', date: '2026-10-01', payableId: 'cxp1', lines: [{ lineIndex: 0, qty: 1 }] },
      { id: 'r2', date: '2026-10-02', payableId: 'cxp2', lines: [{ lineIndex: 0, qty: 2 }] },
    ],
    ...over,
  });

  function fuentes(datos: {
    ventas?: VentaGuardada[];
    gastos?: GastoGuardado[];
    ordenes?: OrdenGuardada[];
    vivos?: Record<string, string[]>;
    /** Orígenes cuyo asiento original existe pero está reversado. */
    reversados?: Record<string, string[]>;
    pendientes?: PendienteAbierto[];
  }) {
    const vivos = new Map(Object.entries(datos.vivos ?? {}).map(([k, v]) => [k, new Set(v)]));
    const reversados = new Map(
      Object.entries(datos.reversados ?? {}).map(([k, v]) => [k, new Set(v)]),
    );
    const reversar = (t: string, id: string) => {
      vivos.get(t)?.delete(id);
      reversados.set(t, new Set([...(reversados.get(t) ?? []), id]));
    };
    const posting = {
      postSale: vi.fn(async (i: { saleId: string }) => void vivos.set('sale', new Set([...(vivos.get('sale') ?? []), i.saleId]))),
      reverseSale: vi.fn(async (id: string) => reversar('sale', id)),
      postExpense: vi.fn(async (i: { expenseId: string }) => void vivos.set('expense', new Set([...(vivos.get('expense') ?? []), i.expenseId]))),
      reverseExpense: vi.fn(async (id: string) => reversar('expense', id)),
      postPurchaseReceipt: vi.fn(async (i: { receiptId: string }) =>
        void vivos.set('purchase_receipt', new Set([...(vivos.get('purchase_receipt') ?? []), i.receiptId])),
      ),
    };
    let pendientes = [...(datos.pendientes ?? [])];
    const f: FuentesReconstruccion = {
      origenesVivos: async (t) => new Set(vivos.get(t) ?? []),
      origenesRegistrados: async (t) =>
        new Set([...(vivos.get(t) ?? []), ...(reversados.get(t) ?? [])]),
      ventas: async () => datos.ventas ?? [],
      gastos: async () => datos.gastos ?? [],
      ordenes: async () => datos.ordenes ?? [],
      naturalezaDeCategorias: async () => new Map([['cat-1', 'expense']]),
      descuentaIva: async () => () => true,
      pendientes: async () => pendientes,
      resolver: vi.fn(async (p) => {
        pendientes = pendientes.filter((x) => x !== p);
      }),
      posting: posting as never,
    };
    return { f, posting };
  }

  it('la venta se reconstruye con los mismos montos que postea SalesService', () => {
    expect(insumoVenta(venta())).toMatchObject({
      saleId: 'v1',
      date: '2026-10-13',
      total: 119_000,
      tax: 19_000,
      consumptionTax: 0,
      cogs: 42_500,
      deliveryFee: 5_000,
      tip: 11_900,
      onCredit: false,
    });
    expect(insumoVenta(venta({ paymentMethod: 'credit' }))!.onCredit).toBe(true);
    // Una venta anterior a oct-2026 no tiene impuesto del domicilio ni bolsas.
    expect(insumoVenta(venta())!.deliveryTax).toBeUndefined();
    expect(insumoVenta(venta())!.bagTax).toBe(0);
  });

  it('domicilio con INC y bolsas: se reconstruyen como los postea SalesService', () => {
    const r = insumoVenta(
      venta({ deliveryTaxKind: 'inc', deliveryTax: 370, bagTaxTotal: 146 }),
    )!;
    expect(r.deliveryTax).toEqual({ kind: 'inc', amount: 370 });
    expect(r.bagTax).toBe(146);
  });

  it('cobro mixto (ítem 6.9): el reparto pasa al asiento y no se trata como fiado entero', () => {
    const payments = [
      { method: 'credit', amount: 100_000 },
      { method: 'cash', amount: 35_900 },
    ];
    const mixta = insumoVenta(venta({ paymentMethod: 'credit', payments }))!;
    expect(mixta.payments).toEqual(payments);
    expect(mixta.onCredit).toBe(false);
    // Un reparto de un solo medio es una venta de siempre.
    const uno = insumoVenta(venta({ payments: [{ method: 'cash', amount: 1 }] }))!;
    expect(uno.payments).toBeUndefined();
  });

  it('las recepciones parciales reparten el IVA del renglón sin perder un peso', () => {
    const r = recepcionesDeOrden(orden(), true);
    const ivas = r.map((x) => (x.tipo === 'postear' ? x.input.ivaDescontable! : -1));
    expect(ivas).toEqual([1_900, 3_800]);
    expect(ivas[0]! + ivas[1]!).toBe(5_700);
    // Sin IVA descontable, el IVA va al costo del inventario.
    const sinDescuento = recepcionesDeOrden(orden(), false);
    expect(sinDescuento[0]).toMatchObject({ tipo: 'postear', input: { amount: 11_900, ivaDescontable: 0 } });
  });

  it('no adivina el medio de pago de una compra de contado ni el id de una recepción vieja', () => {
    const r = recepcionesDeOrden(
      orden({
        receipts: [
          { id: 'r1', date: '2026-10-01', lines: [{ lineIndex: 0, qty: 1 }] },
          { date: '2026-10-02', payableId: 'cxp', lines: [{ lineIndex: 0, qty: 1 }] },
        ],
      }),
      true,
    );
    expect(r.map((x) => x.tipo)).toEqual(['contado', 'sinId']);
  });

  it('la cuenta del gasto es la misma que usa FinanceService', () => {
    const finance = Object.create(FinanceService.prototype) as { expenseAccountFor(k: string): unknown };
    for (const kind of CATEGORY_KINDS) {
      expect(cuentaDeGasto(kind)).toBe(finance.expenseAccountFor(kind));
    }
  });

  it('en seco cuenta y no escribe nada', async () => {
    const { f, posting } = fuentes({
      ventas: [venta(), venta({ id: 'v2', status: 'void' })],
      gastos: [gasto()],
      ordenes: [orden()],
      vivos: { sale: ['v2'], expense: ['g-borrado'] },
    });

    const c = await reconstruirAsientos(f, false);

    expect(c).toMatchObject({
      ventasSinAsiento: 1,
      ventasAnuladasConAsiento: 1,
      gastosSinAsiento: 1,
      asientosDeGastosBorrados: 1,
      recepcionesSinAsiento: 2,
    });
    for (const fn of Object.values(posting)) expect(fn).not.toHaveBeenCalled();
    expect(f.resolver).not.toHaveBeenCalled();
  });

  it('al aplicar, repara todo y una segunda corrida ya no encuentra nada', async () => {
    const { f, posting } = fuentes({
      ventas: [venta(), venta({ id: 'v2', status: 'void' })],
      gastos: [gasto()],
      ordenes: [orden()],
      vivos: { sale: ['v2'], expense: ['g-borrado'] },
      pendientes: [{ sourceType: 'sale', sourceId: 'v1', operacion: 'post' }],
    });

    await reconstruirAsientos(f, true);

    expect(posting.postSale).toHaveBeenCalledOnce();
    expect(posting.reverseSale).toHaveBeenCalledWith('v2', expect.any(String));
    expect(posting.postExpense).toHaveBeenCalledOnce();
    expect(posting.reverseExpense).toHaveBeenCalledWith('g-borrado', expect.any(String));
    expect(posting.postPurchaseReceipt).toHaveBeenCalledTimes(2);
    expect(f.resolver).toHaveBeenCalledOnce();

    const despues = await reconstruirAsientos(f, false);
    expect(Object.entries(despues).filter(([, n]) => n > 0)).toEqual([]);
  });

  it('un gasto editado cuya reversa falló: reversa el viejo y postea el vigente', async () => {
    const { f, posting } = fuentes({
      gastos: [gasto({ amount: 80_000 })],
      vivos: { expense: ['g1'] },
      pendientes: [{ sourceType: 'expense', sourceId: 'g1', operacion: 'reverse' }],
    });

    const seco = await reconstruirAsientos(f, false);
    expect(seco.gastosPorRehacer).toBe(1);
    expect(seco.gastosSinAsiento).toBe(0);

    await reconstruirAsientos(f, true);
    expect(posting.reverseExpense.mock.invocationCallOrder[0]!).toBeLessThan(
      posting.postExpense.mock.invocationCallOrder[0]!,
    );
    expect(posting.postExpense.mock.calls[0]![0]).toMatchObject({ amount: 80_000 });
    expect(f.resolver).toHaveBeenCalledOnce();
  });

  it('los pendientes de otros orígenes quedan contados para conciliar a mano', async () => {
    const { f } = fuentes({
      pendientes: [{ sourceType: 'payroll_run', sourceId: 'n1', operacion: 'post' }],
    });
    await reconstruirAsientos(f, true);
    const c = await reconstruirAsientos(f, false);
    expect(c.pendientesManuales).toBe(1);
    expect(f.resolver).not.toHaveBeenCalled();
  });

  describe('lo reversado a propósito no se repostea', () => {
    it('un gasto con su asiento reversado y sin pendiente se deja como está', async () => {
      const { f, posting } = fuentes({
        gastos: [gasto()],
        reversados: { expense: ['g1'] },
      });

      const c = await reconstruirAsientos(f, true);

      expect(posting.postExpense).not.toHaveBeenCalled();
      expect(c.gastosSinAsiento).toBe(0);
      expect(c.reversadosSinReposteo).toBe(1);
    });

    it('sí lo repostea si quedó un pendiente «post» (la edición reversó y el reposteo falló)', async () => {
      const { f, posting } = fuentes({
        gastos: [gasto()],
        reversados: { expense: ['g1'] },
        pendientes: [{ sourceType: 'expense', sourceId: 'g1', operacion: 'post' }],
      });

      const seco = await reconstruirAsientos(f, false);
      expect(seco.gastosSinAsiento).toBe(1);

      await reconstruirAsientos(f, true);
      expect(posting.postExpense).toHaveBeenCalledOnce();
      expect(f.resolver).toHaveBeenCalledOnce();
    });

    it('igual con ventas y recepciones: solo se postea lo que nunca tuvo asiento', async () => {
      const { f, posting } = fuentes({
        ventas: [venta()],
        ordenes: [orden()],
        reversados: { sale: ['v1'], purchase_receipt: ['oc1:r1'] },
      });

      await reconstruirAsientos(f, true);

      expect(posting.postSale).not.toHaveBeenCalled();
      expect(posting.postPurchaseReceipt).toHaveBeenCalledOnce();
      expect(posting.postPurchaseReceipt.mock.calls[0]![0].receiptId).toBe('oc1:r2');
    });
  });
});
