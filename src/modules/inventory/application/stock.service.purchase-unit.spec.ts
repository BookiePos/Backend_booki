import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
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

import { StockService } from './stock.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Entrada de mercancía en la presentación en que llega.
 *
 * El proveedor despacha 3 bultos de harina y cobra por bulto; el sistema
 * costea por gramo porque así lo piden las recetas. La conversión se hace aquí
 * —no en la pantalla— para que sea una sola cuenta con un solo dueño.
 *
 * Lo que se protege: que "3" no entre como 3 gramos (inventario en cero y
 * alertas de reposición falsas) y que "$95.000" no quede como costo del gramo
 * (cada receta veinticinco mil veces más cara, en silencio).
 */
describe('StockService.entry · presentación de compra', () => {
  const sedeId = new Types.ObjectId();
  const harinaId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'bodeguero@bookipos.local',
    name: 'Bodeguero',
    role: 'manager',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let stockItemModel: any;
  let lotModel: any;
  let movementModel: any;
  let products: any;
  let service: StockService;
  let producto: any;

  /** Harina: se consume en gramos y se compra en bultos de 25 kg. */
  function build(overrides: Record<string, unknown> = {}) {
    producto = {
      _id: harinaId,
      name: 'Harina',
      unit: 'g',
      active: true,
      perishable: false,
      trackLots: true,
      cost: 3.8,
      purchaseUnit: 'bulto',
      purchaseFactor: 25_000,
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    stockItemModel = {
      findOneAndUpdate: vi.fn(() => ({
        exec: () => Promise.resolve({ qty: 75_000 }),
      })),
    };
    lotModel = {
      create: vi.fn((docs: any[]) =>
        Promise.resolve(docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))),
      ),
    };
    movementModel = {
      create: vi.fn((docs: unknown[]) => Promise.resolve(docs)),
    };
    products = { getOrFail: vi.fn().mockResolvedValue(producto) };

    service = new StockService(
      stockItemModel as never,
      lotModel as never,
      movementModel as never,
      // Sin replica set el servicio corre sin sesión; se imita ese camino.
      { connectionFor: () => ({ transaction: (cb: any) => cb(undefined) }) } as never,
      products as never,
      { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  /** El único lote creado por la entrada. */
  function lote(): any {
    return lotModel.create.mock.calls[0][0][0];
  }

  /** El único movimiento de kardex escrito. */
  function movimiento(): any {
    return movementModel.create.mock.calls[0][0][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('3 bultos entran como 75.000 g y el precio del bulto queda por gramo', async () => {
    build();

    await service.entry(
      {
        productId: harinaId.toString(),
        sedeId: sedeId.toString(),
        qty: 3,
        unitCost: 95_000,
        inPurchaseUnits: true,
      } as never,
      user,
    );

    expect(stockItemModel.findOneAndUpdate.mock.calls[0][1]).toEqual({
      $inc: { qty: 75_000 },
    });
    expect(lote().qty).toBe(75_000);
    expect(lote().initialQty).toBe(75_000);
    expect(lote().unitCost).toBe(3.8);
    expect(movimiento().delta).toBe(75_000);
    expect(movimiento().unitCost).toBe(3.8);
  });

  it('el último costo del producto se guarda por gramo, no por bulto', async () => {
    build({ cost: 3.8 });

    await service.entry(
      {
        productId: harinaId.toString(),
        sedeId: sedeId.toString(),
        qty: 2,
        unitCost: 100_000, // subió el bulto
        inPurchaseUnits: true,
      } as never,
      user,
    );

    expect(producto.cost).toBe(4); // 100.000 / 25.000
    expect(producto.save).toHaveBeenCalled();
  });

  it('sin la marca, la entrada sigue siendo en unidades de consumo', async () => {
    build();

    await service.entry(
      {
        productId: harinaId.toString(),
        sedeId: sedeId.toString(),
        qty: 500,
        unitCost: 4,
      } as never,
      user,
    );

    // Aunque el producto TENGA presentación de compra: quien no la pide,
    // sigue hablando en gramos. Así los flujos viejos no cambian de sentido.
    expect(lote().qty).toBe(500);
    expect(lote().unitCost).toBe(4);
  });

  it('sin precio digitado, hereda el costo del producto sin convertirlo dos veces', async () => {
    build({ cost: 3.8 });

    await service.entry(
      {
        productId: harinaId.toString(),
        sedeId: sedeId.toString(),
        qty: 1,
        inPurchaseUnits: true,
      } as never,
      user,
    );

    expect(lote().qty).toBe(25_000);
    expect(lote().unitCost).toBe(3.8);
    expect(producto.save).not.toHaveBeenCalled();
  });

  it('pedir la conversión en un producto sin presentación es un 400, no un silencio', async () => {
    // El peor desenlace posible sería aceptarlo como factor 1: "3 bultos"
    // entrarían como 3 gramos y el inventario quedaría en nada.
    build({ purchaseUnit: undefined, purchaseFactor: undefined });

    await expect(
      service.entry(
        {
          productId: harinaId.toString(),
          sedeId: sedeId.toString(),
          qty: 3,
          unitCost: 95_000,
          inPurchaseUnits: true,
        } as never,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una caja de 12 gaseosas funciona igual: la presentación no es solo de peso', async () => {
    build({ unit: 'und', purchaseUnit: 'caja', purchaseFactor: 12, cost: 3_000 });

    await service.entry(
      {
        productId: harinaId.toString(),
        sedeId: sedeId.toString(),
        qty: 5,
        unitCost: 36_000,
        inPurchaseUnits: true,
      } as never,
      user,
    );

    expect(lote().qty).toBe(60);
    expect(lote().unitCost).toBe(3_000);
  });
});
