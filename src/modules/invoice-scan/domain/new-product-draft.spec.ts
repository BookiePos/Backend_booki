import { describe, it, expect } from 'vitest';
import { newProductMissing } from './new-product-draft';

/**
 * La ficha de un producto nuevo creada desde una foto: completa y revisada, o
 * no se crea nada.
 */
describe('newProductMissing', () => {
  const completa = {
    itemType: 'ingredient',
    sku: 'ARROZ-500',
    name: 'Arroz Diana 500 g',
    unit: 'und',
    categoryId: 'cat1',
    cost: 2500,
    minStock: 0,
    salePrice: 3500,
    reviewed: true,
  };

  it('una ficha completa y revisada no tiene pendientes', () => {
    expect(newProductMissing(completa)).toEqual([]);
  });

  it('sin ficha, falta todo', () => {
    expect(newProductMissing(undefined)).toHaveLength(9);
  });

  it('lo leído sin confirmar no alcanza, aunque esté todo lleno', () => {
    expect(newProductMissing({ ...completa, reviewed: false })).toEqual([
      'confirmar los datos que se leyeron de la factura',
    ]);
  });

  it('el stock mínimo en cero es un dato, no un hueco', () => {
    expect(newProductMissing({ ...completa, minStock: 0 })).toEqual([]);
    expect(newProductMissing({ ...completa, minStock: undefined })).toEqual([
      'el stock mínimo',
    ]);
  });

  it('pide precio de venta salvo que se marque que no se vende', () => {
    expect(newProductMissing({ ...completa, salePrice: undefined })).toEqual([
      'el precio de venta (o marcar que no se vende en el POS)',
    ]);
    expect(
      newProductMissing({ ...completa, salePrice: undefined, notSold: true }),
    ).toEqual([]);
  });

  it('la presentación es opcional, pero con nombre exige cuánto trae', () => {
    // "bulto" a secas no sirve: es justo el número con el que "3 bultos" se
    // vuelven 75.000 g. Sin él, la compra entraría como 3 gramos.
    expect(
      newProductMissing({ ...completa, purchaseUnit: 'bulto' }),
    ).toEqual(['cuánto trae un bulto']);
    expect(
      newProductMissing({ ...completa, purchaseUnit: 'bulto', purchaseFactor: 25000 }),
    ).toEqual([]);
    expect(newProductMissing({ ...completa, purchaseFactor: 25000 })).toEqual([]);
  });

  it('un costo en cero o espacios en blanco cuentan como faltantes', () => {
    expect(
      newProductMissing({ ...completa, cost: 0, sku: '  ', name: '' }),
    ).toEqual(['el SKU', 'el nombre', 'el costo de compra']);
  });
});
