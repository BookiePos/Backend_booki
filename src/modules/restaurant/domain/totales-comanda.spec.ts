import { describe, it, expect } from 'vitest';
import { totalesDeComanda } from './totales-comanda';

/**
 * La comanda es la precuenta que ve el cliente. El precio de la carta ya trae
 * el INC (el precio al público incluye los impuestos, Ley 1480 art. 26) y así
 * lo cobra el POS. Antes la comanda sumaba el INC encima: la mesa veía 42.480
 * y en caja se cobraban 39.600.
 */
describe('totalesDeComanda', () => {
  const items = [{ unitPrice: 18_000, qty: 2 }];

  it('el INC va incluido en el consumo y el total es consumo + propina', () => {
    expect(totalesDeComanda(items, 8, 10, true)).toEqual({
      subtotal: 36_000,
      incAmount: 2_667,
      tipAmount: 3_600,
      total: 39_600,
    });
  });

  it('sin propina el total es el consumo', () => {
    expect(totalesDeComanda(items, 8, 10, false)).toMatchObject({ tipAmount: 0, total: 36_000 });
  });

  it('una comanda vacía no tiene nada', () => {
    expect(totalesDeComanda([], 8, 10, true)).toEqual({
      subtotal: 0,
      incAmount: 0,
      tipAmount: 0,
      total: 0,
    });
  });
});
