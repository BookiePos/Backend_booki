import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Aquí los modelos van
// mockeados. Mismo patrón que `sales/application/orders.service.checkout.spec.ts`.
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

import { CatalogService } from './catalog.service';
import type { ProductDocument } from '../../inventory/infrastructure/schemas/product.schema';

/**
 * Qué ítem de inventario aparece solo en el POS.
 *
 * Esto estuvo roto en silencio y por eso hay test. La condición miraba
 * `itemType === 'product'`, pero la ficha de inventario crea su "Producto" como
 * `ingredient`: el tendero le ponía precio a la gaseosa, guardaba, y nunca
 * aparecía en la caja. No había error, ni log, ni forma de notarlo salvo abrir
 * el POS y no encontrarla. Lo que manda es el PRECIO, que es donde el usuario
 * declara que algo se vende; el tipo de ítem no decide.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas:
 * (model, productModel, categoryModel, inventory, storage).
 */
describe('CatalogService.syncFromInventory · qué se vende solo', () => {
  const productId = new Types.ObjectId();

  /** Ítem de inventario con lo mínimo que mira la sincronización. */
  function invItem(
    overrides: Partial<{
      itemType: string;
      active: boolean;
      salePrice?: number;
      variantAxes?: { name: string; values: string[] }[];
    }> = {},
  ): ProductDocument {
    return {
      _id: productId,
      sku: 'COCA400',
      name: 'Coca-Cola 400ml',
      itemType: 'ingredient',
      active: true,
      salePrice: 3_000,
      categoryId: undefined,
      ...overrides,
    } as unknown as ProductDocument;
  }

  let model: any;
  let existingAuto: any;
  let service: CatalogService;

  beforeEach(() => {
    existingAuto = null;
    model = {
      // Primera llamada: ¿hay ya un vendible automático? Segunda: ¿uno manual?
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(existingAuto) })),
      create: vi.fn().mockResolvedValue({}),
    };
    service = new CatalogService(
      model as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('publica en el POS un "Producto" de inventario (ingredient) con precio', async () => {
    await service.syncFromInventory(invItem());

    expect(model.create).toHaveBeenCalledOnce();
    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: 'COCA400',
        name: 'Coca-Cola 400ml',
        salePrice: 3_000,
        sourceType: 'inventory',
        inventoryProductId: productId,
        qtyPerUnit: 1,
        autoFromInventory: true,
      }),
    );
  });

  it('sigue publicando las variantes de retail, que son itemType product', async () => {
    await service.syncFromInventory(invItem({ itemType: 'product' }));

    expect(model.create).toHaveBeenCalledOnce();
  });

  it('publica también un montaje con precio (lo que sale de Producción)', async () => {
    await service.syncFromInventory(invItem({ itemType: 'assembly' }));

    expect(model.create).toHaveBeenCalledOnce();
  });

  it('no publica un insumo sin precio de venta', async () => {
    await service.syncFromInventory(invItem({ salePrice: undefined }));

    expect(model.create).not.toHaveBeenCalled();
  });

  it('no publica un ítem inactivo', async () => {
    await service.syncFromInventory(invItem({ active: false }));

    expect(model.create).not.toHaveBeenCalled();
  });

  it('no publica el padre-plantilla de variantes: agrupa, no se vende', async () => {
    await service.syncFromInventory(
      invItem({ variantAxes: [{ name: 'Talla', values: ['M', 'L'] }] }),
    );

    expect(model.create).not.toHaveBeenCalled();
  });

  it('retira del POS el vendible automático cuando el ítem pierde el precio', async () => {
    existingAuto = {
      imagePathname: undefined,
      deleteOne: vi.fn().mockResolvedValue(undefined),
    };

    await service.syncFromInventory(invItem({ salePrice: 0 }));

    expect(existingAuto.deleteOne).toHaveBeenCalledOnce();
    expect(model.create).not.toHaveBeenCalled();
  });

  it('no duplica: si ya hay un vendible, lo actualiza en vez de crear otro', async () => {
    existingAuto = { save: vi.fn().mockResolvedValue(undefined) };

    await service.syncFromInventory(invItem({ salePrice: 4_500 }));

    expect(existingAuto.save).toHaveBeenCalledOnce();
    expect(existingAuto.salePrice).toBe(4_500);
    expect(model.create).not.toHaveBeenCalled();
  });
});
