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

import { OrdersService } from './orders.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 3.10 (auditor de permisos): GET /orders/:id leía la cuenta abierta de
 * cualquier sede. Ahora exige la sede de la cuenta, como listar y editar.
 */
describe('OrdersService.getForUser · alcance por sede', () => {
  const sedeA = new Types.ObjectId();
  const sedeB = new Types.ObjectId();
  const orderId = new Types.ObjectId();

  const service = new OrdersService(
    {
      findById: vi.fn().mockReturnValue({
        populate: () => ({
          exec: () =>
            Promise.resolve({
              _id: orderId,
              id: orderId.toString(),
              status: 'open',
              sedeId: { _id: sedeB, code: 'B', name: 'Sede B' },
              lines: [],
            }),
        }),
      }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const cajero = (sedes: Types.ObjectId[]) =>
    ({ userId: 'u', sedeIds: sedes.map(String), permissions: ['pos.sell'] }) as unknown as JwtUser;

  it('el cajero de otra sede no la ve', async () => {
    await expect(service.getForUser(orderId.toString(), cajero([sedeA]))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('el de la sede sí', async () => {
    const order = await service.getForUser(orderId.toString(), cajero([sedeB]));
    expect(order.id).toBe(orderId.toString());
  });
});
