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

import { SalesService } from './sales.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 3.9: alcance por sede en ventas. Un cajero de la sede A no lee las
 * ventas de la B, ni por listado ni pidiendo una por su id.
 */
describe('SalesService · alcance por sede', () => {
  const sedeA = new Types.ObjectId();
  const sedeB = new Types.ObjectId();
  const cajeroA = {
    userId: 'u1',
    role: 'cashier',
    permissions: ['pos.sell'],
    sedeIds: [sedeA.toString()],
  } as unknown as JwtUser;
  const duena = { ...cajeroA, role: 'owner', sedeIds: [] } as unknown as JwtUser;

  function makeService(sedeDeLaVenta: Types.ObjectId) {
    const saleModel = {
      findById: vi.fn().mockReturnValue({
        populate: () => ({
          exec: () =>
            Promise.resolve({ _id: new Types.ObjectId(), sedeId: { _id: sedeDeLaVenta } }),
        }),
      }),
      countDocuments: vi.fn(),
      find: vi.fn(),
    };
    const ctor = SalesService as unknown as new (...args: unknown[]) => SalesService;
    return { service: new ctor(saleModel), saleModel };
  }

  it('una venta de otra sede da 403 al pedirla por id', async () => {
    const { service } = makeService(sedeB);
    await expect(
      service.getForUser(new Types.ObjectId().toString(), cajeroA),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una venta de su sede sí la ve', async () => {
    const { service } = makeService(sedeA);
    await expect(
      service.getForUser(new Types.ObjectId().toString(), cajeroA),
    ).resolves.toBeTruthy();
  });

  it('el Dueño ve la de cualquier sede', async () => {
    const { service } = makeService(sedeB);
    await expect(
      service.getForUser(new Types.ObjectId().toString(), duena),
    ).resolves.toBeTruthy();
  });

  it('el listado de otra sede da 403 sin consultar', async () => {
    const { service, saleModel } = makeService(sedeB);
    await expect(service.list(sedeB.toString(), cajeroA)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(saleModel.find).not.toHaveBeenCalled();
  });
});
