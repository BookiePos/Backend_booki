import { describe, it, expect } from 'vitest';
import { maxTip } from './tip-limit';

/** Ley 1935 de 2018: la propina en la factura no puede pasar del 10 %. */
describe('maxTip', () => {
  it('es el 10 % del consumo', () => {
    expect(maxTip(50_000)).toBe(5_000);
  });

  it('redondea hacia arriba: el 10 % que sugiere el POS siempre cabe', () => {
    // 10 % de 11.905 = 1.190,5; el POS sugiere Math.round → 1.191.
    expect(maxTip(11_905)).toBe(1_191);
    expect(Math.round(11_905 * 0.1)).toBeLessThanOrEqual(maxTip(11_905));
  });

  it('sin consumo no hay propina posible', () => {
    expect(maxTip(0)).toBe(0);
  });
});
