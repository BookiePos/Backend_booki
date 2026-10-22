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
  let sedeModel: any;
  let businesses: any;
  /** Responsabilidad fiscal de la sede: por omisión responsable de IVA (descuenta). */
  let sedeFiscal: Record<string, unknown>;

  function build(opts: { libres?: any[]; modified?: number } = {}) {
    const libres = opts.libres ?? [
      { _id: s1, total: 100_000, deliveryFee: 5_000, platform: { accountingDate: '2026-10-01' } },
      { _id: s2, total: 95_000, deliveryFee: 0, platform: { accountingDate: '2026-10-01' } },
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
    sedeFiscal = { responsableIva: true };
    sedeModel = { findById: vi.fn(() => ({ select: () => exec(sedeFiscal) })) };
    businesses = { findById: vi.fn().mockResolvedValue({ tipoNegocio: 'retail' }) };
    service = new PlatformSettlementsService(saleModel, settlementModel, ledger, treasury, sedeModel, businesses);
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
    build({ libres: [{ _id: s1, total: 100_000, deliveryFee: 5_000, platform: {} }] });
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

  it('IVA de la comisión: descontable solo si la sede es responsable de IVA', async () => {
    await service.create(dto(), user);
    expect(ledger.postPlatformSettlement.mock.calls[0][0].ivaDescontable).toBe(true);

    build();
    sedeFiscal = { responsableIva: false };
    await service.create(dto(), user);
    expect(ledger.postPlatformSettlement.mock.calls[0][0].ivaDescontable).toBe(false);
    expect(settlementModel.create.mock.calls[0][0].ivaDescontable).toBe(false);
  });

  it('retenciones y ajuste de precio entran en la ecuación y viajan al asiento', async () => {
    // bruto 200.000 + ajuste 8.000 = 208.000 = 150.000 + 40.000 + 5.000 + (6.000 + 2.000 + 5.000)
    const r = await service.create(
      dto({
        received: 150_000,
        commission: 40_000,
        commissionIva: 5_000,
        retefuente: 6_000,
        reteIca: 2_000,
        reteIva: 5_000,
        ajustePrecio: 8_000,
      }),
      user,
    );
    expect(r.ajustePrecio).toBe(8_000);
    const a = ledger.postPlatformSettlement.mock.calls[0][0];
    expect([a.retefuente, a.reteIca, a.reteIva, a.ajustePrecio]).toEqual([6_000, 2_000, 5_000, 8_000]);
    // Sin el ajuste no cuadra.
    await expect(
      service.create(
        dto({ received: 150_000, commission: 40_000, commissionIva: 5_000, retefuente: 6_000, reteIca: 2_000, reteIva: 5_000 }),
        user,
      ),
    ).rejects.toThrow(/No cuadra/);
  });

  describe('fecha de la liquidación', () => {
    it('no puede ser anterior al pedido más reciente que cobra', async () => {
      build({
        libres: [
          { _id: s1, total: 100_000, deliveryFee: 5_000, platform: { accountingDate: '2026-10-12' } },
          { _id: s2, total: 95_000, deliveryFee: 0, platform: { accountingDate: '2026-10-05' } },
        ],
      });
      await expect(service.create(dto({ date: '2026-10-10' }), user)).rejects.toThrow(/anterior al pedido más reciente.*2026-10-12/);
      await expect(service.create(dto({ date: '2026-10-12' }), user)).resolves.toBeTruthy();
    });

    it('de un mes anterior se lleva a hoy', async () => {
      build({
        libres: [
          { _id: s1, total: 100_000, deliveryFee: 5_000, platform: { accountingDate: '2020-01-01' } },
          { _id: s2, total: 95_000, deliveryFee: 0, platform: { accountingDate: '2020-01-02' } },
        ],
      });
      const r = await service.create(dto({ date: '2020-01-15' }), user);
      expect(r.date).toBe(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }));
    });
  });

  describe('anular', () => {
    const id = new Types.ObjectId();
    const base = () => {
      settlementModel.findById = vi.fn(() => exec({ _id: id, sedeId, status: 'active' }));
      settlementModel.findOneAndUpdate = vi
        .fn()
        .mockReturnValueOnce(exec({ _id: id, sedeId, status: 'voiding' }))
        .mockReturnValueOnce(exec({ _id: id, sedeId, status: 'void' }));
    };

    it('reversa el asiento, saca la tesorería, libera los pedidos y queda void', async () => {
      base();
      const r = await service.void(id.toString(), user);
      expect(r.status).toBe('void');
      expect(ledger.reversePlatformSettlement).toHaveBeenCalledWith(id.toString(), 'dueno@x.co');
      expect(treasury.reverse).toHaveBeenCalledWith('platform_settlement', id.toString());
      expect(saleModel.updateMany).toHaveBeenCalledWith(
        { 'platform.settlementId': id },
        { $unset: { 'platform.settlementId': '' } },
      );
    });

    it('si la reversa del libro falla NO libera los pedidos ni pasa a void', async () => {
      base();
      ledger.reversePlatformSettlement.mockRejectedValue(new Error('libro caído'));
      await expect(service.void(id.toString(), user)).rejects.toThrow(/Reintenta/);
      expect(saleModel.updateMany).not.toHaveBeenCalled();
      expect(settlementModel.findOneAndUpdate).toHaveBeenCalledTimes(1); // solo la toma (voiding)
    });

    it('si liberar lanza, no queda en void: queda reintentable', async () => {
      base();
      saleModel.updateMany = vi.fn(() => ({ exec: () => Promise.reject(new Error('base caída')) }));
      await expect(service.void(id.toString(), user)).rejects.toThrow(/Reintenta/);
      expect(settlementModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it('anular una ya anulada es 400 y no reversa otra vez', async () => {
      settlementModel.findById = vi.fn(() => exec({ _id: id, sedeId, status: 'void' }));
      settlementModel.findOneAndUpdate = vi.fn(() => exec(null));
      await expect(service.void(id.toString(), user)).rejects.toBeInstanceOf(BadRequestException);
      expect(ledger.reversePlatformSettlement).not.toHaveBeenCalled();
    });
  });
});
