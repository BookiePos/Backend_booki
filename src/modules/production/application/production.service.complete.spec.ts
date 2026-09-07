import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata de tipo para los @Prop() con uniones de
// literales, y @nestjs/mongoose lanza al no poder inferirlo. Estos tests no
// usan los esquemas reales (los modelos van mockeados), así que neutralizamos
// los decoradores para poder importar el servicio.
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

// El catálogo arrastra el cliente de Supabase Storage, que no hace falta aquí.
// Se corta la cadena de imports en seco.
vi.mock('../../catalog/application/catalog.service', () => ({
  CatalogService: class {},
}));

import { ProductionService } from './production.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Cierre de una orden de producción.
 *
 * Se instancia el servicio DIRECTAMENTE con dependencias mockeadas (sin DI de
 * Nest ni Mongo real). El constructor es:
 *   (boms, orders, counterModel, products, stock, catalog)
 *
 * Lo que se protege aquí es lo que duele si se rompe: que un reintento no
 * consuma los insumos dos veces, y que el costo del terminado salga del costo
 * REAL de los lotes consumidos y no de un promedio del catálogo.
 */
describe('ProductionService.complete', () => {
  const sedeId = new Types.ObjectId();
  const orderId = new Types.ObjectId();
  const harinaId = new Types.ObjectId();
  const levaduraId = new Types.ObjectId();
  const panId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'panadero@bookipos.local',
    name: 'Panadero',
    role: 'manager',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  /** Orden abierta: 120 panes con 25 kg de harina y 0.5 kg de levadura. */
  function openOrderDoc() {
    return {
      _id: orderId,
      sedeId,
      status: 'in_progress',
      number: 'OP-000007',
      date: '2026-09-07',
      productId: panId,
      productName: 'Pan francés',
      unit: 'und',
      plannedQty: 120,
      producedQty: 0,
      extraCost: 30_000,
      lines: [
        {
          productId: harinaId,
          description: 'Harina · 10001',
          unit: 'kg',
          qty: 25,
          qtyConsumed: 0,
          unitCost: 0,
          subtotal: 0,
        },
        {
          productId: levaduraId,
          description: 'Levadura · 10002',
          unit: 'kg',
          qty: 0.5,
          qtyConsumed: 0,
          unitCost: 0,
          subtotal: 0,
        },
      ],
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  let boms: any;
  let orders: any;
  let counterModel: any;
  let products: any;
  let stock: any;
  let service: ProductionService;
  let order: ReturnType<typeof openOrderDoc>;

  beforeEach(() => {
    order = openOrderDoc();

    boms = { find: vi.fn(), findOne: vi.fn(), findById: vi.fn(), exists: vi.fn() };
    orders = {
      findById: vi.fn(() => ({ exec: () => Promise.resolve(order) })),
      // Reserva atómica con `{ new: true }`: Mongo devuelve el documento YA
      // actualizado, así que el mock aplica el $set en vez de devolver el
      // original. Sin esto el test comprobaría el stub, no el servicio.
      findOneAndUpdate: vi.fn((_filter: unknown, update: any) => ({
        exec: () => {
          for (const [key, value] of Object.entries(update.$set ?? {})) {
            const lineMatch = /^lines\.(\d+)\.(\w+)$/.exec(key);
            if (lineMatch) {
              const line = order.lines[Number(lineMatch[1])] as any;
              if (line) line[lineMatch[2] as string] = value;
            } else {
              (order as any)[key] = value;
            }
          }
          return Promise.resolve(order);
        },
      })),
      aggregate: vi.fn().mockResolvedValue([]),
    };
    counterModel = {};
    products = {
      getOrFail: vi.fn(async (id: string) => ({
        _id: new Types.ObjectId(id),
        name: 'Pan francés',
        unit: 'und',
        perishable: false,
        cost: 0,
        active: true,
      })),
    };
    stock = {
      // Hay de sobra de los dos insumos.
      availableQty: vi.fn().mockResolvedValue(1_000),
      // Dos lotes de harina a distinto costo + un lote de levadura.
      consumeLines: vi.fn().mockResolvedValue([
        {
          product: { _id: harinaId, name: 'Harina', cost: 3_000 },
          portions: [
            { qty: 10, lot: { unitCost: 3_000 } },
            { qty: 15, lot: { unitCost: 3_200 } },
          ],
        },
        {
          product: { _id: levaduraId, name: 'Levadura', cost: 20_000 },
          portions: [{ qty: 0.5, lot: { unitCost: 20_000 } }],
        },
      ]),
      entry: vi.fn().mockResolvedValue({}),
    };

    service = new ProductionService(
      boms,
      orders,
      counterModel,
      products,
      stock,
      {} as any,
    );
  });

  it('costea el terminado con el costo real de los lotes consumidos', async () => {
    const result = await service.complete(orderId.toString(), {}, user);

    // Harina: 10×3.000 + 15×3.200 = 78.000. Levadura: 0,5×20.000 = 10.000.
    expect(result.materialsCost).toBe(88_000);
    // Más la mano de obra del lote (30.000).
    expect(result.totalCost).toBe(118_000);
    // Repartido entre las 120 unidades planeadas.
    expect(result.unitCost).toBe(Math.round(118_000 / 120));

    // Cada renglón queda con su costo real, no con el del catálogo.
    expect(result.lines[0]?.subtotal).toBe(78_000);
    expect(result.lines[1]?.subtotal).toBe(10_000);
  });

  it('reparte el costo entre la salida REAL, no entre la planeada', async () => {
    // Se planearon 120 panes pero salieron 114: el costo unitario sube.
    const result = await service.complete(
      orderId.toString(),
      { producedQty: 114 },
      user,
    );

    expect(result.producedQty).toBe(114);
    expect(result.unitCost).toBe(Math.round(118_000 / 114));
    expect(stock.entry).toHaveBeenCalledWith(
      expect.objectContaining({ qty: 114, unitCost: Math.round(118_000 / 114) }),
      user,
      { movementType: 'production_in' },
    );
  });

  it('descuenta los insumos como salida de producción, no como venta', async () => {
    await service.complete(orderId.toString(), {}, user);

    expect(stock.consumeLines).toHaveBeenCalledWith(
      'production_out',
      sedeId.toString(),
      [
        { productId: harinaId.toString(), qty: 25 },
        { productId: levaduraId.toString(), qty: 0.5 },
      ],
      user,
      { note: 'Producción OP-000007' },
    );
  });

  it('no vuelve a consumir si la reserva atómica no gana la carrera', async () => {
    // Otra llamada cerró la orden entre medias: findOneAndUpdate no encuentra
    // ninguna orden abierta y devuelve null.
    orders.findOneAndUpdate = vi.fn(() => ({ exec: () => Promise.resolve(null) }));

    await service.complete(orderId.toString(), {}, user);

    expect(stock.consumeLines).not.toHaveBeenCalled();
    expect(stock.entry).not.toHaveBeenCalled();
  });

  it('rechaza el cierre si falta algún insumo, sin tocar el inventario', async () => {
    stock.availableQty = vi.fn(async (productId: string) =>
      productId === harinaId.toString() ? 4 : 1_000,
    );

    await expect(
      service.complete(orderId.toString(), {}, user),
    ).rejects.toBeInstanceOf(BadRequestException);

    // La orden sigue abierta y nada se movió.
    expect(orders.findOneAndUpdate).not.toHaveBeenCalled();
    expect(stock.consumeLines).not.toHaveBeenCalled();
  });

  it('exige vencimiento cuando el terminado es perecedero', async () => {
    products.getOrFail = vi.fn().mockResolvedValue({
      _id: panId,
      name: 'Pan francés',
      unit: 'und',
      perishable: true,
      cost: 0,
      active: true,
    });

    await expect(
      service.complete(orderId.toString(), {}, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stock.consumeLines).not.toHaveBeenCalled();
  });

  it('no reabre una orden ya terminada', async () => {
    order.status = 'done';

    await expect(
      service.complete(orderId.toString(), {}, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stock.consumeLines).not.toHaveBeenCalled();
  });
});
