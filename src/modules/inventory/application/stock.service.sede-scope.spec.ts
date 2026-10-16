import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
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

import { StockService } from './stock.service';
import { InventoryController } from '../infrastructure/inventory.controller';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 3.9: alcance por sede en inventario. El encargado de la sede A no
 * mueve existencias de la B (entrada, ajuste, conteo, traslado) ni las lee.
 */
describe('StockService · alcance por sede', () => {
  const sedeA = new Types.ObjectId().toString();
  const sedeB = new Types.ObjectId().toString();
  const productId = new Types.ObjectId().toString();
  const gerenteA = {
    userId: 'u1',
    role: 'manager',
    permissions: ['inventory.adjust'],
    sedeIds: [sedeA],
  } as unknown as JwtUser;

  function makeService() {
    const products = { getOrFail: vi.fn() };
    const stockItemModel = {
      find: vi.fn().mockReturnValue({
        populate: () => ({ populate: () => ({ sort: () => ({ exec: () => Promise.resolve([]) }) }) }),
      }),
    };
    const lotModel = { aggregate: vi.fn().mockResolvedValue([]) };
    const service = new StockService(
      stockItemModel as never,
      lotModel as never,
      {} as never,
      {} as never,
      products as never,
      { findOrFail: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, products, stockItemModel };
  }

  it('entrada, ajuste y conteo en otra sede dan 403 antes de tocar nada', async () => {
    const { service, products } = makeService();
    await expect(
      service.entry({ sedeId: sedeB, productId, qty: 1, unitCost: 100 } as never, gerenteA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.adjust({ sedeId: sedeB, productId, qty: -1 } as never, gerenteA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.applyCount({ sedeId: sedeB, lines: [] } as never, gerenteA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(products.getOrFail).not.toHaveBeenCalled();
  });

  it('un traslado exige acceso a las DOS sedes', async () => {
    const { service } = makeService();
    await expect(
      service.transfer(
        { fromSedeId: sedeA, toSedeId: sedeB, productId, qty: 1 } as never,
        gerenteA,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.transfer(
        { fromSedeId: sedeB, toSedeId: sedeA, productId, qty: 1 } as never,
        gerenteA,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('las existencias sin sede pedida se limitan a las del usuario', async () => {
    const { service, stockItemModel } = makeService();
    const controller = new InventoryController({} as never, service, {} as never);
    await controller.getStock(gerenteA);
    const filtro = stockItemModel.find.mock.calls[0]![0] as {
      sedeId: { $in: Types.ObjectId[] };
    };
    expect(filtro.sedeId.$in.map(String)).toEqual([sedeA]);
  });

  it('pedir las existencias de otra sede da 403', () => {
    const { service } = makeService();
    const controller = new InventoryController({} as never, service, {} as never);
    expect(() => controller.getStock(gerenteA, sedeB)).toThrow(ForbiddenException);
  });
});
