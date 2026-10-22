import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
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

import { PlatformSettlementsService } from './platform-settlements.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const exec = <T>(v: T) => ({
  exec: () => Promise.resolve(v),
  select: () => ({ exec: () => Promise.resolve(v) }),
});

describe('PlatformSettlementsService · liquidación de plataformas (7.5)', () => {
  const sedeId = new Types.ObjectId();
  const s1 = new Types.ObjectId();
  const s2 = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'dueno@x.co',
    role: 'owner',
    permissions: ['finance.manage'],
    sedeIds: [sedeId.toString()],
  } as unknown as JwtUser;

  let saleModel: any;
  let settlementModel: any;
  let ledger: any;
  let treasury: any;
  let service: PlatformSettlementsService;

  function build(opts: { libres?: any[]; modified?: number } = {}) {
    const libres = opts.libres ?? [
      { _id: s1, total: 100_000, deliveryFee: 5_000 },
      { _id: s2, total: 95_000, deliveryFee: 0 },
    ];
    saleModel = {
      find: vi.fn(() => exec(libres)),
      updateMany: vi.fn(() => exec({ modifiedCount: opts.modified ?? libres.length })),
    };
    settlementModel = {
      create: vi.fn((d: any) => Promise.resolve({ ...d, _id: new Types.ObjectId() })),
      deleteOne: vi.fn(() => exec({})),
    };
    ledger = {
      postPlatformSettlement: vi.fn().mockResolvedValue(undefined),
      reversePlatformSettlement: vi.fn().mockResolvedValue(undefined),
    };
    treasury = {
      post: vi.fn().mockResolvedValue(undefined),
      reverse: vi.fn().mockResolvedValue(undefined),
    };
    service = new PlatformSettlementsService(saleModel, settlementModel, ledger, treasury);
  }

  const dto = (extra: Record<string, unknown> = {}) =>
    ({
      sedeId: sedeId.toString(),
      platform: 'rappi',
      saleIds: [s1.toString(), s2.toString()],
      received: 160_000,
      commission: 35_000,
      commissionIva: 5_000,
      date: '2026-10-10',
      ...extra,
    }) as never;

  beforeEach(() => build());

  it('cuadra: bruto 200.000 = consignado 160.000 + comisión 35.000 + IVA 5.000', async () => {
    const r = await service.create(dto(), user);
    expect(r.gross).toBe(200_000);
    const a = ledger.postPlatformSettlement.mock.calls[0][0];
    expect(a.gross).toBe(a.received + a.commission + a.commissionIva);
    expect(treasury.post).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'platform_settlement', direction: 'in', amount: 160_000 }),
    );
  });

  it('rechaza una liquidación que no cuadra y no toca pedidos ni libro', async () => {
    await expect(service.create(dto({ received: 150_000 }), user)).rejects.toThrow(
      /No cuadra: faltan/,
    );
    expect(settlementModel.create).not.toHaveBeenCalled();
    expect(saleModel.updateMany).not.toHaveBeenCalled();
    expect(ledger.postPlatformSettlement).not.toHaveBeenCalled();
  });

  it('un pedido ya liquidado, anulado o de otra plataforma/sede es 400', async () => {
    build({ libres: [{ _id: s1, total: 100_000, deliveryFee: 5_000 }] });
    await expect(service.create(dto(), user)).rejects.toBeInstanceOf(BadRequestException);
    expect(ledger.postPlatformSettlement).not.toHaveBeenCalled();
  });

  it('el filtro exige sede, plataforma, completado y sin liquidar', async () => {
    await service.create(dto(), user);
    const f = saleModel.find.mock.calls[0][0];
    expect(f.sedeId.toString()).toBe(sedeId.toString());
    expect(f['platform.code']).toBe('rappi');
    expect(f.status).toBe('completed');
    expect(f['platform.settlementId']).toEqual({ $exists: false });
  });

  it('si otra liquidación se adelantó (reserva corta) suelta lo reservado, borra y no postea', async () => {
    build({ modified: 1 });
    await expect(service.create(dto(), user)).rejects.toBeInstanceOf(ConflictException);
    expect(settlementModel.deleteOne).toHaveBeenCalled();
    // reserva + liberación
    expect(saleModel.updateMany).toHaveBeenCalledTimes(2);
    expect(ledger.postPlatformSettlement).not.toHaveBeenCalled();
  });

  it('los ids repetidos no inflan el bruto', async () => {
    const r = await service.create(
      dto({ saleIds: [s1.toString(), s1.toString(), s2.toString()] }),
      user,
    );
    expect(r.saleIds).toHaveLength(2);
    expect(r.gross).toBe(200_000);
  });

  it('una sede ajena da 403', async () => {
    await expect(
      service.create(dto({ sedeId: new Types.ObjectId().toString() }), {
        ...user,
        role: 'manager',
      } as JwtUser),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(saleModel.find).not.toHaveBeenCalled();
  });

  it('una fecha futura se rechaza', async () => {
    await expect(service.create(dto({ date: '2999-01-01' }), user)).rejects.toThrow(/futura/);
  });

  describe('anular', () => {
    it('reversa el asiento, saca la tesorería y libera los pedidos', async () => {
      const id = new Types.ObjectId();
      settlementModel.findById = vi.fn(() => exec({ _id: id, sedeId, status: 'active' }));
      settlementModel.findOneAndUpdate = vi.fn(() => exec({ _id: id, sedeId, status: 'void' }));
      await service.void(id.toString(), user);
      expect(ledger.reversePlatformSettlement).toHaveBeenCalledWith(id.toString(), 'dueno@x.co');
      expect(treasury.reverse).toHaveBeenCalledWith('platform_settlement', id.toString());
      expect(saleModel.updateMany).toHaveBeenCalledWith(
        { 'platform.settlementId': id },
        { $unset: { 'platform.settlementId': '' } },
      );
    });

    it('anular dos veces: la segunda es 400 y no reversa otra vez', async () => {
      const id = new Types.ObjectId();
      settlementModel.findById = vi.fn(() => exec({ _id: id, sedeId, status: 'void' }));
      settlementModel.findOneAndUpdate = vi.fn(() => exec(null));
      await expect(service.void(id.toString(), user)).rejects.toBeInstanceOf(BadRequestException);
      expect(ledger.reversePlatformSettlement).not.toHaveBeenCalled();
    });
  });
});
