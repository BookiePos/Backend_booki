import { describe, it, expect } from 'vitest';
import { planDeRebaja, RebajaInvalidaError, saldoRebajable } from './sale-rebate';
import { buildReturnPlan, refundForLine } from './sale-return';

/** Rebaja posterior (Fase 6C): tope, reparto e impuesto en COP entero. */
describe('planDeRebaja', () => {
  const vendidos = [
    { productId: 'h', qty: 3, taxBase: 27_778, taxAmount: 2_222 }, // INC 8 %
    { productId: 'g', qty: 2, taxBase: 8_403, taxAmount: 1_597 }, // IVA 19 %
    { productId: 'x', qty: 1, taxBase: 5_001, taxAmount: 0 }, // excluido
  ];
  const nada = new Map();

  it('reparte el total en proporción a lo que queda y la suma es exacta', () => {
    const p = planDeRebaja(vendidos, nada, { total: 10_001 });
    expect(p.amount).toBe(10_001);
    expect(p.lines.reduce((s, l) => s + l.amount, 0)).toBe(10_001);
    expect(p.lines.find((l) => l.productId === 'x')!.tax).toBe(0);
    expect(p.tax).toBe(p.lines.reduce((s, l) => s + l.tax, 0));
    for (const l of p.lines) expect(Number.isInteger(l.amount) && Number.isInteger(l.tax)).toBe(true);
  });

  it('por producto: el impuesto sale de la proporción que queda; si agota, lleva el impuesto exacto', () => {
    expect(planDeRebaja(vendidos, nada, { porProducto: [{ productId: 'h', amount: 3_000 }] }).lines[0]).toEqual({
      productId: 'h',
      amount: 3_000,
      tax: 222,
    });
    expect(planDeRebaja(vendidos, nada, { porProducto: [{ productId: 'h', amount: 30_000 }] }).lines[0]!.tax).toBe(2_222);
  });

  it('descuenta lo devuelto y lo ya rebajado del tope', () => {
    const ya = new Map([['h', { refund: 10_000, refundTax: 741, rebated: 5_000, rebatedTax: 370 }]]);
    expect(saldoRebajable(vendidos, ya).get('h')).toEqual({ valor: 15_000, impuesto: 1_111 });
    expect(() => planDeRebaja(vendidos, ya, { porProducto: [{ productId: 'h', amount: 15_001 }] })).toThrow(
      RebajaInvalidaError,
    );
    expect(planDeRebaja(vendidos, ya, { porProducto: [{ productId: 'h', amount: 15_000 }] }).lines[0]!.tax).toBe(1_111);
  });

  it('rechaza total y líneas a la vez, ninguno, producto ajeno o total por encima de lo vendido', () => {
    expect(() => planDeRebaja(vendidos, nada, {})).toThrow(RebajaInvalidaError);
    expect(() => planDeRebaja(vendidos, nada, { total: 1, porProducto: [{ productId: 'h', amount: 1 }] })).toThrow(
      RebajaInvalidaError,
    );
    expect(() => planDeRebaja(vendidos, nada, { porProducto: [{ productId: 'z', amount: 1 }] })).toThrow(/no estaba/);
    expect(() => planDeRebaja(vendidos, nada, { total: 45_002 })).toThrow(/pasa de lo que queda/);
    expect(() => planDeRebaja(vendidos, nada, { total: 0 })).toThrow(RebajaInvalidaError);
  });
});

describe('devolución después de una rebaja', () => {
  const linea = { productId: 'h', qty: 10, taxBase: 9_259, taxAmount: 741 }; // $10.000 con INC

  it('la última devolución salda exacto lo pagado menos lo rebajado (con impuesto)', () => {
    const rebaja = { rebated: 3_000, rebatedTax: 222 };
    const a = refundForLine(linea, 4, { qty: 0, refund: 0, refundTax: 0, ...rebaja });
    const b = refundForLine(linea, 6, { qty: 4, refund: a.refund, refundTax: a.refundTax, ...rebaja });
    expect(a.refund + b.refund).toBe(7_000);
    expect(a.refundTax + b.refundTax).toBe(519);
    expect(a.refund).toBe(2_800);
  });

  it('una rebaja después de una devolución parcial: entre todo nunca pasa de lo pagado', () => {
    const a = refundForLine(linea, 2, { qty: 0, refund: 0, refundTax: 0 }); // $2.000
    const b = refundForLine(linea, 8, { qty: 2, refund: a.refund, refundTax: a.refundTax, rebated: 3_000, rebatedTax: 222 });
    expect(a.refund + 3_000 + b.refund).toBe(10_000);
    expect(a.refundTax + 222 + b.refundTax).toBe(741);
  });

  it('buildReturnPlan pasa las rebajas por producto', () => {
    const p = buildReturnPlan([linea], [{ productId: 'h', qty: 10 }], new Map(), new Map(), new Map([['h', { amount: 1_000, tax: 74 }]]));
    expect(p.refundTotal).toBe(9_000);
    expect(p.refundTax).toBe(667);
  });
});
