import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { netearVentas, TOP_PRODUCTOS } from './sales-returns.report';

/**
 * «Ventas por día» neto de devoluciones (R3, revisión 1.16). La devolución
 * resta el día en que ocurre, como la 4175 en el libro (art. 484 ET).
 */
const S1 = new Types.ObjectId('64b0000000000000000000a1');
const S2 = new Types.ObjectId('64b0000000000000000000a2');
const P1 = new Types.ObjectId('64b0000000000000000000b1');
const P2 = new Types.ObjectId('64b0000000000000000000b2');

const ventas = {
  days: [
    { _id: '2026-03-01', revenue: 100_000, tax: 15_966, tickets: 3 },
    { _id: '2026-03-02', revenue: 50_000, tax: 7_983, tickets: 2 },
  ],
  bySede: [
    { _id: S1, revenue: 120_000, tickets: 4 },
    { _id: S2, revenue: 30_000, tickets: 1 },
  ],
  topProducts: [
    { _id: P1, name: 'Pan', qty: 10, revenue: 90_000 },
    { _id: P2, name: 'Café', qty: 6, revenue: 60_000 },
  ],
  totals: [{ revenue: 150_000, tax: 23_949, tickets: 5 }],
};

const retornos = {
  days: [
    // Devolución el 2 de una venta del 1: resta el 2.
    { _id: '2026-03-02', amount: 36_000, tax: 5_748, count: 1 },
    // Día sin ventas, solo con devoluciones.
    { _id: '2026-03-03', amount: 9_000, tax: 1_437, count: 2 },
  ],
  bySede: [{ _id: S1, amount: 45_000, count: 3 }],
  byMethod: [
    { _id: 'cash', amount: 36_000, count: 1 },
    { _id: 'credit_note', amount: 9_000, count: 2 },
  ],
  byReason: [{ _id: 'defectuoso', amount: 45_000, count: 3 }],
  products: [{ _id: P1, name: 'Pan', qty: 5, refund: 45_000 }],
  totals: [{ amount: 45_000, tax: 7_185, count: 3 }],
};

describe('netearVentas', () => {
  const r = netearVentas(ventas, retornos);

  it('cada día trae bruto, devoluciones y neto; resta el día de la devolución', () => {
    expect(r.days).toEqual([
      {
        date: '2026-03-01',
        grossRevenue: 100_000,
        returns: 0,
        returnsCount: 0,
        revenue: 100_000,
        tax: 15_966,
        tickets: 3,
        avgTicket: 33_333,
      },
      {
        date: '2026-03-02',
        grossRevenue: 50_000,
        returns: 36_000,
        returnsCount: 1,
        revenue: 14_000,
        tax: 2_235,
        tickets: 2,
        avgTicket: 7_000,
      },
      {
        date: '2026-03-03',
        grossRevenue: 0,
        returns: 9_000,
        returnsCount: 2,
        revenue: -9_000,
        tax: -1_437,
        tickets: 0,
        avgTicket: 0,
      },
    ]);
  });

  it('los totales van netos y cuadran con la suma de los días', () => {
    expect(r.totalGrossRevenue).toBe(150_000);
    expect(r.totalReturns).toBe(45_000);
    expect(r.totalReturnsCount).toBe(3);
    expect(r.totalRevenue).toBe(105_000);
    expect(r.totalTax).toBe(16_764);
    expect(r.totalTickets).toBe(5);
    expect(r.avgTicket).toBe(21_000);
    expect(r.days.reduce((a, d) => a + d.revenue, 0)).toBe(r.totalRevenue);
  });

  it('por sede, neto', () => {
    expect(r.bySede).toEqual([
      { sedeId: S1.toString(), grossRevenue: 120_000, returns: 45_000, returnsCount: 3, revenue: 75_000, tickets: 4 },
      { sedeId: S2.toString(), grossRevenue: 30_000, returns: 0, returnsCount: 0, revenue: 30_000, tickets: 1 },
    ]);
  });

  it('top productos neto: se reordena después de restar lo devuelto', () => {
    expect(r.topProducts.map((p) => [p.name, p.qty, p.revenue, p.returnedQty, p.returned])).toEqual([
      ['Café', 6, 60_000, 0, 0],
      ['Pan', 5, 45_000, 5, 45_000],
    ]);
  });

  it('un producto con descuento devuelto entero queda en neto 0', () => {
    // Bruto 10.000 con 1.000 de descuento: la faceta de ventas ya entrega
    // 9.000 (lineTotal − discountAmount) y el reembolso es esos mismos 9.000.
    const out = netearVentas(
      { ...ventas, topProducts: [{ _id: P2, name: 'Café', qty: 1, revenue: 9_000 }] },
      { products: [{ _id: P2, name: 'Café', qty: 1, refund: 9_000 }] },
    );
    expect(out.topProducts[0]).toMatchObject({ qty: 0, revenue: 0, returned: 9_000 });
  });

  it('el top se recorta a 10 después de netear', () => {
    const id0 = new Types.ObjectId();
    const muchos = Array.from({ length: 15 }, (_, i) => ({
      _id: i === 0 ? id0 : new Types.ObjectId(),
      name: `P${i}`,
      qty: 1,
      revenue: 1_000 * (15 - i),
    }));
    // Al primero le devuelven todo: sale del top y entra el 11.
    const out = netearVentas(
      { ...ventas, topProducts: muchos },
      { products: [{ _id: id0, name: 'P0', qty: 1, refund: 15_000 }] },
    );
    expect(out.topProducts).toHaveLength(TOP_PRODUCTOS);
    expect(out.topProducts.map((p) => p.name)).not.toContain('P0');
    expect(out.topProducts.map((p) => p.name)).toContain('P10');
  });

  it('el bloque de devoluciones trae conteo, monto, IVA, medio y motivo', () => {
    expect(r.returns).toEqual({
      count: 3,
      amount: 45_000,
      tax: 7_185,
      byMethod: [
        { method: 'cash', amount: 36_000, count: 1 },
        { method: 'credit_note', amount: 9_000, count: 2 },
      ],
      byReason: [{ reason: 'defectuoso', amount: 45_000, count: 3 }],
      topProducts: [{ productId: P1.toString(), name: 'Pan', qty: 5, refund: 45_000 }],
    });
  });

  it('sin datos, todo en cero y sin fallar', () => {
    const vacio = netearVentas(undefined, undefined);
    expect(vacio.days).toEqual([]);
    expect(vacio.totalRevenue).toBe(0);
    expect(vacio.avgTicket).toBe(0);
    expect(vacio.returns.count).toBe(0);
  });
});
