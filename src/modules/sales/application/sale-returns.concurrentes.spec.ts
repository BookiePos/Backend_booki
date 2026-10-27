import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';

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

import { SaleReturnsService } from './sale-returns.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 4.11: dos devoluciones simultáneas del total de una venta leían el
 * mismo «ya devuelto» (cero), pasaban las dos el tope y cada una sacaba el
 * efectivo de la caja. La colección de este doble es compartida, como la base
 * real: las dos peticiones se intercalan y ven lo que la otra ya guardó.
 */
describe('SaleReturnsService · devoluciones concurrentes', () => {
  const sedeId = new Types.ObjectId();
  const saleId = new Types.ObjectId();
  const GASEOSA = new Types.ObjectId();
  const INV = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  const sale = {
    _id: saleId,
    saleNumber: 'FV-000123',
    sedeId: { _id: sedeId },
    status: 'completed',
    lines: [
      { productId: GASEOSA, sku: 'G1', name: 'Gaseosa', qty: 10, unitPrice: 2_500, taxBase: 21_008, taxAmount: 3_992 },
    ],
    components: [
      { productId: INV, qty: 10, cost: 9_000, consumedLots: [{ lotId: new Types.ObjectId(), qty: 10, unitCost: 900 }] },
    ],
  };

  function build() {
    const registros: any[] = [];
    const model = {
      find: vi.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve([...registros]) }),
        exec: () => Promise.resolve([...registros]),
      })),
      create: vi.fn(async (doc: any) => {
        const r = { ...doc, _id: new Types.ObjectId(), save: vi.fn() };
        registros.push(r);
        return r;
      }),
      deleteOne: vi.fn((f: { _id: Types.ObjectId }) => ({
        exec: async () => {
          const i = registros.findIndex((r) => r._id.equals(f._id));
          if (i >= 0) registros.splice(i, 1);
          return { deletedCount: i >= 0 ? 1 : 0 };
        },
      })),
    };
    const caja = { movement: vi.fn().mockResolvedValue(undefined) };
    const stock = { reverseSale: vi.fn().mockResolvedValue(undefined), adjust: vi.fn() };
    const service = new SaleReturnsService(
      model as never,
      { getOrFail: vi.fn().mockResolvedValue(sale) } as never,
      stock as never,
      {
        loadSellableOrFail: vi.fn().mockResolvedValue({ _id: GASEOSA, name: 'Gaseosa' }),
        componentsOf: vi.fn((_p: unknown, qty: number) => [{ productId: INV.toString(), qty }]),
      } as never,
      caja as never,
      { postSaleReturn: vi.fn().mockResolvedValue(undefined) } as never,
    );
    return { service, registros, caja, stock };
  }

  const total = {
    lines: [{ productId: GASEOSA.toString(), qty: 10 }],
    reason: 'defectuoso',
    restock: 'inventory',
    refundMethod: 'cash',
  } as never;

  it('dos devoluciones del total a la vez no devuelven más de lo vendido', async () => {
    const { service, registros, caja, stock } = build();
    await Promise.allSettled([
      service.create(saleId.toString(), total, user),
      service.create(saleId.toString(), total, user),
    ]);
    const devuelto = registros.reduce(
      (n, r) => n + r.lines.reduce((m: number, l: any) => m + l.qty, 0),
      0,
    );
    expect(devuelto).toBeLessThanOrEqual(10);
    expect(caja.movement.mock.calls.length).toBeLessThanOrEqual(1);
    expect(stock.reverseSale.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('una sola devolución del total sigue funcionando', async () => {
    const { service, registros, caja } = build();
    await service.create(saleId.toString(), total, user);
    expect(registros).toHaveLength(1);
    expect(caja.movement).toHaveBeenCalledTimes(1);
  });
});
