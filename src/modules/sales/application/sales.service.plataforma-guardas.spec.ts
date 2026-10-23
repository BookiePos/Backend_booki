import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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
import { SaleReturnsService } from './sale-returns.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 7.5: un pedido de plataforma ya liquidado no se anula (primero se anula
 * la liquidación) y no admite devoluciones del POS (las maneja la plataforma).
 */
describe('Pedido de plataforma · guardas de anulación y devolución', () => {
  const sedeId = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'a@x.co',
    role: 'owner',
    permissions: [],
    sedeIds: [],
  } as unknown as JwtUser;
  const venta = (platform: Record<string, unknown>) => ({
    _id: new Types.ObjectId(),
    status: 'completed',
    sedeId: { _id: sedeId },
    platform,
  });

  it('anular un pedido liquidado es 400 y no toca nada más', async () => {
    const saleModel = { findOneAndUpdate: vi.fn() };
    const saleReturnModel = { countDocuments: vi.fn(() => ({ exec: () => Promise.resolve(0) })) };
    const ctor = SalesService as unknown as new (...a: unknown[]) => SalesService;
    const args: unknown[] = Array.from({ length: 22 }, () => ({}));
    args[0] = saleModel;
    args[20] = saleReturnModel;
    const service = new ctor(...args);
    vi.spyOn(service, 'getOrFail').mockResolvedValue(
      venta({ code: 'rappi', externalId: 'R-1', settlementId: new Types.ObjectId() }) as never,
    );
    await expect(service.void(new Types.ObjectId().toString(), user)).rejects.toThrow(
      /ya está liquidado/,
    );
    expect(saleModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('devolver parte de un pedido de plataforma es 400', async () => {
    const sales = {
      getOrFail: vi.fn().mockResolvedValue(venta({ code: 'didi', externalId: 'D-1' })),
    };
    const ctor = SaleReturnsService as unknown as new (...a: unknown[]) => SaleReturnsService;
    const service = new ctor({}, sales, {}, {}, {}, {});
    await expect(
      service.create(new Types.ObjectId().toString(), { lines: [] } as never, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(new Types.ObjectId().toString(), { lines: [] } as never, user),
    ).rejects.toThrow(/plataforma/);
  });
});
