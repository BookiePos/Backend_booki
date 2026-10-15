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

import { CajaService } from './caja.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 3.9: alcance por sede en caja. El cajero de la sede A no ve la caja,
 * el historial ni el resumen del día de la sede B, ni le mete movimientos.
 */
describe('CajaService · alcance por sede', () => {
  const sedeA = new Types.ObjectId().toString();
  const sedeB = new Types.ObjectId().toString();
  const cajeroA = {
    userId: 'u1',
    role: 'cashier',
    permissions: ['caja.open'],
    sedeIds: [sedeA],
  } as unknown as JwtUser;

  function makeService() {
    const sessions = {
      find: vi.fn().mockReturnValue({ sort: () => ({ exec: () => Promise.resolve([]) }) }),
      findOne: vi.fn(),
      countDocuments: vi.fn(),
    };
    const sedes = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ select: () => ({ exec: () => Promise.resolve([]) }) }),
      }),
    };
    const service = new CajaService(
      sessions as never,
      { create: vi.fn() } as never,
      {} as never,
      {} as never,
      sedes as never,
      {} as never,
    );
    return { service, sessions, sedes };
  }

  it('la caja actual y el historial de otra sede dan 403 sin consultar', async () => {
    const { service, sessions } = makeService();
    await expect(service.current(sedeB, cajeroA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.history(sedeB, cajeroA)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessions.findOne).not.toHaveBeenCalled();
    expect(sessions.countDocuments).not.toHaveBeenCalled();
  });

  it('abrir, cerrar o mover dinero en otra sede da 403', async () => {
    const { service } = makeService();
    await expect(
      service.open({ sedeId: sedeB, openingAmount: 0 } as never, cajeroA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.close({ sedeId: sedeB, countedAmount: 0 } as never, cajeroA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.movement({ sedeId: sedeB, type: 'in', amount: 1000 } as never, cajeroA),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el resumen del día solo busca las sedes del usuario', async () => {
    const { service, sedes } = makeService();
    await service.overview(cajeroA);
    const filtro = sedes.find.mock.calls[0]![0] as { _id: { $in: Types.ObjectId[] } };
    expect(filtro._id.$in.map(String)).toEqual([sedeA]);
  });
});
