import { describe, it, expect } from 'vitest';
import { redondearA } from './money.util';

describe('redondearA (cantidades que no son dinero)', () => {
  it('redondea horas y UVT a los decimales pedidos', () => {
    expect(redondearA(7.456, 2)).toBe(7.46);
    expect(redondearA(12.34, 1)).toBe(12.3);
    expect(redondearA(0.125, 2)).toBe(0.13);
  });

  it('trata un valor ausente como cero', () => {
    expect(redondearA(Number.NaN, 2)).toBe(0);
  });
});
