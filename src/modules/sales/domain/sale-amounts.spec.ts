import { describe, it, expect } from 'vitest';
import { chargeForQty, prorateCop, splitTaxIncluded } from './sale-amounts';

/**
 * Ítem 1.11: en la venta no circulan fracciones de peso. Cada reparto se cierra
 * en COP entero y la suma de las partes cuadra EXACTO con el total repartido.
 */
describe('prorateCop · reparto de un monto entero', () => {
  it('descuento que no divide exacto entre tres líneas: partes enteras que suman el total', () => {
    const partes = prorateCop(1_000, [10_000, 10_000, 10_000]);
    expect(partes.every(Number.isInteger)).toBe(true);
    expect(partes.reduce((s, p) => s + p, 0)).toBe(1_000);
    // El residuo cae al final: 333 / 334 / 333 o similar, nunca 333,33.
    for (const p of partes) expect(Math.abs(p - 333.33)).toBeLessThan(1);
  });

  it('ninguna parte se pasa de su peso ni queda negativa (línea final chiquita)', () => {
    // Con el residuo a la brava en la última, aquí saldría −1.
    const pesos = [7, 7, 7, 1];
    const partes = prorateCop(11, pesos);
    expect(partes.reduce((s, p) => s + p, 0)).toBe(11);
    partes.forEach((p, i) => {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(pesos[i]!);
    });
  });

  it('sin pesos no reparte nada', () => {
    expect(prorateCop(0, [0, 0])).toEqual([0, 0]);
    expect(prorateCop(500, [])).toEqual([]);
  });
});

describe('splitTaxIncluded · base e impuesto de un neto con impuesto incluido', () => {
  it('IVA 19 % sobre un precio que deja fracción: base + IVA = neto exacto, en pesos', () => {
    // 9.999 / 1,19 = 8.402,52…
    const r = splitTaxIncluded(9_999, 19);
    expect(r).toEqual({ base: 8_403, tax: 1_596 });
    expect(r.base + r.tax).toBe(9_999);
  });

  it('INC 8 % de restaurante', () => {
    const r = splitTaxIncluded(30_000, 8);
    expect(r).toEqual({ base: 27_778, tax: 2_222 });
  });

  it('sin tarifa: todo es base', () => {
    expect(splitTaxIncluded(10_000, 0)).toEqual({ base: 10_000, tax: 0 });
  });
});

describe('chargeForQty · cuenta dividida', () => {
  it('una línea de $10.001 dividida en tres suma exacto lo consumido', () => {
    // evenShare manda 0,333 + 0,333 y el último paga lo que falta (0,334).
    const a = chargeForQty(10_001, 0, 0.333);
    const b = chargeForQty(10_001, 0.333, 0.333);
    const c = chargeForQty(10_001, 0.666, 0.334);
    for (const x of [a, b, c]) expect(Number.isInteger(x)).toBe(true);
    expect(a + b + c).toBe(10_001);
  });

  it('sin cobros previos es el precio por la cantidad, en pesos', () => {
    expect(chargeForQty(2_500, 0, 0.75)).toBe(1_875);
    expect(chargeForQty(1_001, 0, 0.5)).toBe(501);
  });
});
