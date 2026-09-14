import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// Mismo patrón que el resto de las pruebas: SWC y los @Prop().
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

import { ProductMergeService } from './product-merge.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Fusionar productos duplicados.
 *
 * Lo que se protege:
 *  1. que las existencias se sumen sede por sede y el kardex de los dos
 *     productos explique el cambio, cuadrado;
 *  2. que lo abierto pase al que se queda y lo ya ocurrido (ventas, compras
 *     recibidas) conserve su historial;
 *  3. que una fusión imposible (otra unidad) se rechace sin tocar nada.
 */
describe('ProductMergeService.merge', () => {
  const user = { userId: 'u1', email: 'due@negocio.com' } as unknown as JwtUser;
  const sedeA = new Types.ObjectId();
  const sedeB = new Types.ObjectId();
  const targetId = new Types.ObjectId();
  const sourceId = new Types.ObjectId();

  /** Imita la cadena `.session(...).exec()` de mongoose. */
  const chain = (value: unknown) => {
    const q: any = { session: () => q, exec: () => Promise.resolve(value) };
    return q;
  };

  let docs: Record<string, any>;
  let stockItemModel: any;
  let lotModel: any;
  let movementModel: any;
  let productModel: any;
  let collections: Record<string, any>;
  let products: any;
  let service: ProductMergeService;

  function collectionMock() {
    return {
      updateMany: vi.fn(async () => ({ modifiedCount: 1 })),
      updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
      findOne: vi.fn(async () => null),
    };
  }

  beforeEach(() => {
    docs = {
      [targetId.toString()]: {
        _id: targetId,
        sku: 'COCA-ORIG',
        name: 'Coca cola original',
        unit: 'und',
        active: true,
        trackLots: false,
        cost: 2500,
      },
      [sourceId.toString()]: {
        _id: sourceId,
        sku: 'COCA-FRIO',
        name: 'Coca cola regular friopack',
        unit: 'Unidad',
        active: true,
        trackLots: false,
        cost: 2600,
        barcode: '7702535011119',
      },
    };
    stockItemModel = {
      find: vi.fn(() =>
        chain([
          { _id: new Types.ObjectId(), sedeId: sedeA, qty: 10 },
          { _id: new Types.ObjectId(), sedeId: sedeB, qty: 0 },
        ]),
      ),
      findOneAndUpdate: vi.fn(() => chain({ qty: 15 })),
      updateOne: vi.fn(() => chain({})),
    };
    lotModel = {
      create: vi.fn(async (d: unknown) => d),
      updateMany: vi.fn(() => chain({ modifiedCount: 2 })),
    };
    movementModel = { create: vi.fn(async (d: unknown) => d) };
    productModel = { updateOne: vi.fn(() => chain({})) };
    collections = {};
    const connection = {
      transaction: (cb: (s: undefined) => Promise<void>) => cb(undefined),
      collection: (name: string) => (collections[name] ??= collectionMock()),
    };
    products = {
      getOrFail: vi.fn(async (id: string) => docs[id]),
      syncCatalogRemoved: vi.fn(async () => undefined),
      syncCatalogFor: vi.fn(async () => undefined),
    };
    service = new ProductMergeService(
      productModel,
      stockItemModel,
      lotModel,
      movementModel,
      { connectionFor: () => connection } as never,
      products,
    );
  });

  const merge = () =>
    service.merge(targetId.toString(), [sourceId.toString()], user);

  it('suma las existencias de cada sede y deja el kardex cuadrado', async () => {
    const result = await merge();

    // Solo la sede con existencias se traslada.
    expect(stockItemModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(stockItemModel.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      productId: targetId,
      sedeId: sedeA,
    });
    expect(stockItemModel.findOneAndUpdate.mock.calls[0][1]).toEqual({ $inc: { qty: 10 } });
    expect(stockItemModel.updateOne.mock.calls[0][1]).toEqual({ $set: { qty: 0 } });

    const [salida, entrada] = movementModel.create.mock.calls[0][0];
    expect(salida).toMatchObject({ type: 'merge_out', productId: sourceId, delta: -10, balanceAfter: 0 });
    expect(entrada).toMatchObject({ type: 'merge_in', productId: targetId, delta: 10, balanceAfter: 15 });
    expect(salida.delta + entrada.delta).toBe(0);
    expect(result.stockMoved).toBe(10);
  });

  it('el fusionado queda inactivo apuntando al que se queda, que hereda lo que le faltaba', async () => {
    await merge();

    const updates = productModel.updateOne.mock.calls;
    const fuente = updates.find((c: any[]) => c[0]._id === sourceId);
    expect(fuente[1].$set).toMatchObject({ active: false, mergedInto: targetId });
    const destino = updates.find((c: any[]) => c[0]._id === targetId);
    // Tenía costo propio: no se pisa. No tenía código de barras: lo hereda.
    expect(destino[1].$set).toEqual({ barcode: '7702535011119' });
  });

  it('reasigna solo lo que sigue abierto; ventas y compras recibidas no se tocan', async () => {
    await merge();

    expect(collections.purchase_orders.updateMany.mock.calls[0][0]).toMatchObject({
      status: { $in: ['draft', 'sent', 'partial'] },
    });
    expect(collections.production_orders.updateMany.mock.calls[0][0]).toMatchObject({
      status: { $in: ['draft', 'in_progress'] },
    });
    expect(collections.invoice_scans.updateMany.mock.calls[0][0]).toMatchObject({
      status: { $nin: ['applied', 'discarded'] },
    });
    expect(collections.supplier_item_aliases.updateMany).toHaveBeenCalled();
    // El historial vive en estas colecciones y no se reescribe.
    expect(collections.sales).toBeUndefined();
    expect(collections.sale_returns).toBeUndefined();
    expect(collections.orders).toBeUndefined();
  });

  it('rechaza unidades distintas sin tocar nada', async () => {
    docs[sourceId.toString()].unit = 'kg';

    await expect(merge()).rejects.toThrow(/unidades distintas/);
    expect(stockItemModel.find).not.toHaveBeenCalled();
    expect(productModel.updateOne).not.toHaveBeenCalled();
  });

  it('no fusiona un producto consigo mismo', async () => {
    await expect(
      service.merge(targetId.toString(), [targetId.toString()], user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('si el que se queda controla lotes y el fusionado no, sus existencias entran como lote', async () => {
    docs[targetId.toString()].trackLots = true;

    await merge();

    expect(lotModel.create).toHaveBeenCalledTimes(1);
    expect(lotModel.create.mock.calls[0][0][0]).toMatchObject({
      productId: targetId,
      sedeId: sedeA,
      qty: 10,
      lotCode: 'FUSION-COCA-FRIO',
    });
  });

  it('al terminar rehace el catálogo del POS de los dos productos', async () => {
    await merge();

    expect(products.syncCatalogRemoved).toHaveBeenCalledWith(sourceId);
    expect(products.syncCatalogFor).toHaveBeenCalledTimes(1);
  });
});
