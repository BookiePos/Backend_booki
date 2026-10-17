import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';

// Mismo patrón que el resto de las pruebas de stock.
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
 * Existencias de ejemplo de una plantilla (6.6): NO son una compra. Sin costo,
 * sin lote, sin tocar `product.cost` y sin repetirse.
 */
describe('StockService.sembrarMuestra / quitarMuestras', () => {
  const sedeId = new Types.ObjectId().toString();
  const user = { userId: 'u1', email: 'a@erp.local', role: 'admin', permissions: [], sedeIds: [sedeId] } as unknown as JwtUser;

  function build(opts: { yaHayStock?: boolean; movReal?: boolean } = {}) {
    const producto = { _id: new Types.ObjectId(), cost: 0 };
    const filas: any[] = [];
    const movs: any[] = [];
    const lotes: any[] = [];
    const stockItemModel = {
      exists: () => ({ exec: async () => (opts.yaHayStock ? { _id: 1 } : null) }),
      create: async (docs: any[]) => {
        filas.push(...docs);
        return docs;
      },
      deleteMany: vi.fn(() => ({ exec: async () => undefined })),
    };
    const lotModel = { create: async (d: any[]) => lotes.push(...d) };
    const movementModel = {
      create: async (docs: any[]) => {
        movs.push(...docs);
        return docs;
      },
      exists: () => ({ exec: async () => (opts.movReal ? { _id: 1 } : null) }),
    };
    const tenant = { connectionFor: () => ({ transaction: (fn: any) => fn(undefined) }) };
    const products = { getOrFail: async () => producto };
    const sedes = { findOrFail: async () => ({}) };
    const svc = new StockService(
      stockItemModel as never,
      lotModel as never,
      movementModel as never,
      tenant as never,
      products as never,
      sedes as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, producto, filas, movs, lotes, stockItemModel };
  }

  it('deja un movimiento `sample` con costo 0, sin lote y sin tocar el costo del producto', async () => {
    const { svc, producto, filas, movs, lotes } = build();
    const hecho = await svc.sembrarMuestra({ productId: String(producto._id), sedeId, qty: 30 }, user);
    expect(hecho).toBe(true);
    expect(filas).toEqual([expect.objectContaining({ qty: 30 })]);
    expect(movs).toHaveLength(1);
    expect(movs[0]).toMatchObject({ type: 'sample', delta: 30, balanceAfter: 30, unitCost: 0 });
    expect(movs.every((m) => !(m.unitCost > 0))).toBe(true);
    expect(lotes).toHaveLength(0);
    expect(producto.cost).toBe(0);
  });

  it('no siembra encima de stock que ya existe', async () => {
    const { svc, producto, movs } = build({ yaHayStock: true });
    expect(await svc.sembrarMuestra({ productId: String(producto._id), sedeId, qty: 30 }, user)).toBe(false);
    expect(movs).toHaveLength(0);
  });

  it('quitarMuestras limpia solo lo que nunca tuvo compras ni ajustes', async () => {
    const limpio = build();
    const id = String(new Types.ObjectId());
    expect(await limpio.svc.quitarMuestras([id])).toEqual([id]);
    expect(limpio.stockItemModel.deleteMany).toHaveBeenCalledTimes(1);

    const conCompra = build({ movReal: true });
    expect(await conCompra.svc.quitarMuestras([id])).toEqual([]);
    expect(conCompra.stockItemModel.deleteMany).not.toHaveBeenCalled();
  });
});
