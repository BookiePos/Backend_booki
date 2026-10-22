import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
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
 * Ítem 7.5: pedido de una plataforma de domicilio registrado desde el POS.
 * Es CxC a la plataforma (nunca Caja ni tesorería), no se registra dos veces el
 * mismo (plataforma, código) y el rechazo ocurre ANTES de descontar inventario.
 */
describe('SalesService.create · pedido de plataforma', () => {
  const sedeId = new Types.ObjectId();
  const PROD = new Types.ObjectId();
  const INV = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;
  const otraSede = new Types.ObjectId();

  let creada: any;
  let ledger: any;
  let treasury: any;
  let sell: any;
  let findOne: any;
  let service: SalesService;

  function build(existente: unknown = null) {
    creada = undefined;
    ledger = { postSale: vi.fn().mockResolvedValue(undefined) };
    treasury = { post: vi.fn().mockResolvedValue(undefined) };
    sell = vi.fn((_s: string, lines: any[]) =>
      Promise.resolve(
        lines.map((l) => ({
          product: { _id: INV, sku: 'x', name: 'x', unit: 'und' },
          portions: [{ lot: { _id: new Types.ObjectId(), unitCost: 500 }, qty: l.qty }],
        })),
      ),
    );
    findOne = vi.fn(() => ({
      select: () => ({ exec: () => Promise.resolve(existente) }),
    }));
    const catalog = {
      [PROD.toString()]: {
        _id: PROD, sku: 'A1', name: 'Arepa', unit: 'und', salePrice: 11_900,
        ivaType: 'gravado', ivaRate: 19, sourceType: 'inventory',
        inventoryProductId: INV, qtyPerUnit: 1,
      },
    } as Record<string, any>;
    service = new SalesService(
      {
        create: vi.fn((doc: any) => {
          creada = { ...doc, _id: new Types.ObjectId() };
          return Promise.resolve(creada);
        }),
        findOne,
        deleteOne: vi.fn(),
      } as never,
      { findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({ seq: 1 }) })) } as never,
      { find: vi.fn(() => ({ exec: () => Promise.resolve([{ productId: INV, qty: 999 }]) })) } as never,
      { findOne: vi.fn(() => ({ exec: () => Promise.resolve({ _id: new Types.ObjectId() }) })) } as never,
      {} as never,
      { create: vi.fn() } as never,
      { sell, reverseSale: vi.fn() } as never,
      {} as never,
      { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) } as never,
      {
        loadSellableOrFail: vi.fn((id: string) => Promise.resolve(catalog[id])),
        packagingOf: vi.fn(() => []),
        componentsOf: vi.fn((p: any, qty: number) => [{ productId: p.inventoryProductId.toString(), qty }]),
      } as never,
      { rulesFor: vi.fn().mockResolvedValue(null) } as never,
      { refFor: vi.fn().mockResolvedValue(null) } as never,
      { getOrFail: vi.fn() } as never,
      { createDeduction: vi.fn(), assertEmpleadoParaConsumo: vi.fn() } as never,
      { number: vi.fn().mockResolvedValue(30) } as never,
      ledger as never,
      treasury as never,
      {} as any, {} as any, {} as any, {} as any, {} as any,
    );
  }

  const pedido = (extra: Record<string, unknown> = {}) =>
    ({
      sedeId: sedeId.toString(),
      lines: [{ productId: PROD.toString(), qty: 2 }],
      payment: { method: 'platform' },
      platform: { code: 'rappi', externalId: ' R-1001 ' },
      ...extra,
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    build();
  });

  it('guarda la plataforma y el código, postea a Clientes y no toca tesorería ni efectivo', async () => {
    await service.create(pedido(), user);

    expect(creada.platform).toMatchObject({ code: 'rappi', externalId: 'R-1001' });
    expect(creada.payment.method).toBe('platform');
    expect(creada.payment.received).toBeUndefined();
    expect(creada.orderType).toBe('llevar');
    const asiento = ledger.postSale.mock.calls[0][0];
    expect(asiento.paymentMethod).toBe('platform');
    expect(asiento.onCredit).toBe(false);
    expect(treasury.post).not.toHaveBeenCalled();
  });

  it('un pedido repetido da 409 y NO descuenta inventario (idempotencia)', async () => {
    build({ saleNumber: 'FV-000007' });
    await expect(service.create(pedido(), user)).rejects.toBeInstanceOf(ConflictException);
    expect(sell).not.toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledWith({
      'platform.code': 'rappi',
      'platform.externalId': 'R-1001',
      status: 'completed',
    });
  });

  it('platform sin el medio de pago platform (y al revés) es 400', async () => {
    await expect(
      service.create(pedido({ payment: { method: 'cash' } }), user),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(pedido({ platform: undefined }), user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sell).not.toHaveBeenCalled();
  });

  it('no admite cobro mixto ni propina', async () => {
    await expect(
      service.create(
        pedido({ payment: undefined, payments: [{ method: 'platform', amount: 23_800 }] }),
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(pedido({ tip: 1_000 }), user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(sell).not.toHaveBeenCalled();
  });

  it('una sede ajena da 403 antes de revisar nada', async () => {
    await expect(
      service.create(pedido({ sedeId: otraSede.toString() }), user),
    ).rejects.toThrow(/acceso a esta sede/);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('una carrera (E11000 al crear) compensa el stock y responde 409', async () => {
    const dup = Object.assign(new Error('E11000'), {
      code: 11000,
      keyPattern: { 'platform.code': 1, 'platform.externalId': 1 },
    });
    (service as any).saleModel.create = vi.fn().mockRejectedValue(dup);
    const reverse = (service as any).stock.reverseSale;
    await expect(service.create(pedido(), user)).rejects.toBeInstanceOf(ConflictException);
    expect(sell).toHaveBeenCalledTimes(1);
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  it('un 11000 de OTRO índice no se disfraza de «pedido ya registrado»', async () => {
    const otro = Object.assign(new Error('E11000'), { code: 11000, keyPattern: { saleNumber: 1 } });
    (service as any).saleModel.create = vi.fn().mockRejectedValue(otro);
    await expect(service.create(pedido(), user)).rejects.not.toBeInstanceOf(ConflictException);
  });

  it('un orderedAt futuro se rechaza antes de tocar inventario', async () => {
    await expect(
      service.create(pedido({ platform: { code: 'rappi', externalId: 'R-9', orderedAt: '2999-01-01' } }), user),
    ).rejects.toThrow(/futura/);
    expect(sell).not.toHaveBeenCalled();
  });

  it('la fecha del asiento es la del pedido si es de este mes, si no hoy', async () => {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    await service.create(
      pedido({ platform: { code: 'rappi', externalId: 'R-2', orderedAt: hoy } }),
      user,
    );
    expect(ledger.postSale.mock.calls[0][0].date).toBe(hoy);
    ledger.postSale.mockClear();
    await service.create(
      pedido({ platform: { code: 'rappi', externalId: 'R-3', orderedAt: '2020-01-05' } }),
      user,
    );
    expect(ledger.postSale.mock.calls[0][0].date).toBe(hoy);
    expect(creada.platform.accountingDate).toBe(hoy);
  });
});
