import { describe, it, expect } from 'vitest';
import {
  MAX_PURCHASE_FACTOR,
  normalizePurchase,
  packCost,
  packsToStockQty,
  unitCostFromPack,
} from './purchase-unit';

/**
 * Unidad de compra ≠ unidad de consumo.
 *
 * Lo que se juega aquí es el costo de TODAS las recetas. La harina se consume
 * en gramos; si el precio del bulto ($95.000) se guardara sin dividir, el gramo
 * pasaría a costar $95.000 y cada galleta saldría veinticinco mil veces más
 * cara sin que nada avise. El caso inverso —un bulto registrado como un gramo—
 * deja el inventario en cero y dispara alertas de reposición falsas.
 *
 * Por eso el par nombre+factor se valida junto: un factor sin nombre o un
 * nombre sin factor son estados a medias que producen justo esos errores.
 */
describe('normalizePurchase · el par nombre + factor', () => {
  it('acepta la presentación completa y le quita los espacios al nombre', () => {
    expect(normalizePurchase('  bulto ', 25_000)).toEqual({
      purchaseUnit: 'bulto',
      purchaseFactor: 25_000,
    });
  });

  it('sin nombre ni factor, el producto se compra como se consume', () => {
    expect(normalizePurchase(undefined, undefined)).toEqual({
      purchaseUnit: undefined,
      purchaseFactor: undefined,
    });
  });

  it('un nombre vacío borra la presentación aunque el factor venga en cero', () => {
    expect(normalizePurchase('', 0)).toEqual({
      purchaseUnit: undefined,
      purchaseFactor: undefined,
    });
  });

  it('rechaza un factor suelto: "25000" no dice de qué', () => {
    expect(() => normalizePurchase('', 25_000)).toThrow(/nombre de la presentación/i);
  });

  it('rechaza un nombre sin factor: no se sabría cuánto rinde un bulto', () => {
    expect(() => normalizePurchase('bulto', undefined)).toThrow(/cuánto trae un bulto/i);
    expect(() => normalizePurchase('bulto', 0)).toThrow(/cuánto trae un bulto/i);
    expect(() => normalizePurchase('bulto', -5)).toThrow(/cuánto trae un bulto/i);
  });

  it('rechaza un factor absurdo, que casi siempre es un cero de más', () => {
    expect(() => normalizePurchase('bulto', MAX_PURCHASE_FACTOR + 1)).toThrow(
      /demasiado grande/i,
    );
  });
});

describe('conversiones entre la compra y el consumo', () => {
  it('tres bultos de 25 kg entran como 75.000 g', () => {
    expect(packsToStockQty(3, 25_000)).toBe(75_000);
  });

  it('sin presentación, la cantidad pasa derecho', () => {
    expect(packsToStockQty(3, undefined)).toBe(3);
    expect(packsToStockQty(3, 0)).toBe(3);
  });

  it('el precio del bulto se guarda como costo por gramo', () => {
    expect(unitCostFromPack(95_000, 25_000)).toBe(3.8);
  });

  it('y vuelve a leerse como el precio del bulto', () => {
    expect(packCost(3.8, 25_000)).toBe(95_000);
  });

  it('NO redondea el costo por unidad: $3,80 el gramo no es $4', () => {
    // Redondear aquí inflaría un 5 % cada receta. El redondeo a peso entero se
    // hace al final, sobre el total, con los helpers de `money.util`.
    expect(unitCostFromPack(95_000, 25_000)).not.toBe(4);
    expect(Number.isInteger(unitCostFromPack(95_000, 25_000))).toBe(false);
  });

  it('una caja de 12 gaseosas también sirve: la presentación no tiene que ser de peso', () => {
    expect(packsToStockQty(5, 12)).toBe(60);
    expect(unitCostFromPack(36_000, 12)).toBe(3_000);
  });
});
