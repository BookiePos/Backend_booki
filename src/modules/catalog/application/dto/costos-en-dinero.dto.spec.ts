import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCatalogProductDto } from './create-catalog-product.dto';
import { UpdateCatalogProductDto } from './update-catalog-product.dto';

/**
 * Mano de obra y empaque escritos en dinero son COP entero: el DTO rechaza
 * fracciones y negativos en la puerta, igual que los de producción, en vez de
 * dejar que un redondeo posterior esconda un dato mal escrito.
 */
describe.each([
  ['crear', CreateCatalogProductDto, { sku: 'X', name: 'X', salePrice: 1000, sourceType: 'recipe' }],
  ['editar', UpdateCatalogProductDto, {}],
])('DTO de catálogo (%s) · costos en dinero', (_n, Dto, base) => {
  const errores = async (extra: object) =>
    (await validate(plainToInstance(Dto as any, { ...base, ...extra }) as object))
      .filter((e) => ['laborCost', 'packagingCost'].includes(e.property))
      .map((e) => e.property);

  it('acepta pesos enteros y cero', async () => {
    expect(await errores({ laborCost: 1500, packagingCost: 0 })).toEqual([]);
  });

  it('rechaza fracciones de peso', async () => {
    expect(await errores({ laborCost: 1500.5, packagingCost: 200.25 })).toEqual([
      'laborCost',
      'packagingCost',
    ]);
  });

  it('rechaza negativos', async () => {
    expect(await errores({ packagingCost: -1 })).toEqual(['packagingCost']);
  });
});
