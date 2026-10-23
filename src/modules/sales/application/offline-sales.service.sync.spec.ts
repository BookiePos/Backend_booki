import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Types } from 'mongoose';

// Mismo patrón que el resto de las pruebas de ventas: neutraliza los decoradores.
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

import { OfflineSalesService } from './offline-sales.service';
import { offlineConflict } from './offline-conflict';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const exec = <T>(v: T) => ({ exec: () => Promise.resolve(v) });

/**
 * Sincronización offline (ítem 6.3) con modelos simulados: qué hace con cada
 * clase de error de la venta y con el candado. La concurrencia real (índices
 * únicos) se prueba en `integracion/ventas-offline.integracion.ts`.
 */
describe('OfflineSalesService.sync', () => {
  const sedeId = new Types.ObjectId();
  const resId = new Types.ObjectId();
  const turno = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'c@x',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: ['pos.sell'],
  } as unknown as JwtUser;

  let claims: any;
  let sales: any;
  let saleModel: any;
  let service: OfflineSalesService;

  const dto = () =>
    ({
      offlineId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      reservationId: resId.toString(),
      saleNumber: 'FVC-000003',
      soldAt: new Date().toISOString(),
      expectedGrandTotal: 11_900,
      sale: {
        sedeId: sedeId.toString(),
        lines: [{ productId: new Types.ObjectId().toString(), qty: 1 }],
        payment: { method: 'cash', received: 20_000 },
      },
    }) as any;

  beforeEach(() => {
    claims = {
      findById: vi.fn(() => exec(null)),
      create: vi.fn().mockResolvedValue({}),
      deleteOne: vi.fn(() => exec({})),
      updateOne: vi.fn(() => exec({})),
    };
    saleModel = { findOne: vi.fn(() => exec(null)) };
    sales = {
      create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId(), saleNumber: 'FVC-000003' }),
    };
    service = new OfflineSalesService(
      {} as never,
      {
        findOne: vi.fn(() =>
          exec({
            _id: resId,
            sedeId,
            cajaSessionId: turno,
            userId: 'u1',
            from: 1,
            to: 10,
            createdAt: new Date(Date.now() - 3_600_000),
          }),
        ),
      } as never,
      claims as never,
      saleModel as never,
      { findOne: vi.fn(() => exec({ _id: turno, status: 'open' })) } as never,
      sales as never,
    );
  });

  it('registra con el número, la fecha y el turno de la reserva y cierra el candado', async () => {
    const r = await service.sync(dto(), user);
    expect(r.status).toBe('creada');
    const opts = sales.create.mock.calls[0][3].offline;
    expect(opts).toMatchObject({
      saleNumber: 'FVC-000003',
      cajaSessionId: turno.toString(),
      expectedGrandTotal: 11_900,
    });
    expect(claims.updateOne).toHaveBeenCalledWith(
      { _id: dto().offlineId },
      { $set: { status: 'done', saleId: expect.anything() } },
    );
  });

  it('un reenvío de una venta ya registrada la devuelve sin volver a vender', async () => {
    saleModel.findOne = vi.fn(() => exec({ _id: new Types.ObjectId(), sedeId }));
    const r = await service.sync(dto(), user);
    expect(r.status).toBe('duplicada');
    expect(sales.create).not.toHaveBeenCalled();
  });

  it('el UUID de una venta de otra sede no se devuelve', async () => {
    saleModel.findOne = vi.fn(() =>
      exec({ _id: new Types.ObjectId(), sedeId: new Types.ObjectId() }),
    );
    await expect(service.sync(dto(), user)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('candado reciente en proceso: EN_PROCESO sin vender', async () => {
    claims.findById = vi.fn(() => exec({ status: 'processing', createdAt: new Date() }));
    await expect(service.sync(dto(), user)).rejects.toMatchObject({
      response: { reason: 'EN_PROCESO' },
    });
    expect(sales.create).not.toHaveBeenCalled();
  });

  it('candado huérfano viejo: se libera y la venta se registra', async () => {
    claims.findById = vi.fn(() => exec({ status: 'processing', createdAt: new Date(0) }));
    const r = await service.sync(dto(), user);
    expect(r.status).toBe('creada');
    expect(claims.deleteOne).toHaveBeenCalled();
  });

  it('un 4xx de la venta se vuelve RECHAZADA y suelta el candado', async () => {
    sales.create.mockRejectedValue(new BadRequestException('Algo no cuadra'));
    await expect(service.sync(dto(), user)).rejects.toMatchObject({
      response: { reason: 'RECHAZADA', message: 'Algo no cuadra' },
    });
    expect(claims.deleteOne).toHaveBeenCalledWith({
      _id: dto().offlineId,
      status: 'processing',
    });
  });

  it('un conflicto ya clasificado pasa tal cual', async () => {
    sales.create.mockRejectedValue(offlineConflict('SIN_STOCK', 'no hay'));
    await expect(service.sync(dto(), user)).rejects.toMatchObject({
      response: { reason: 'SIN_STOCK' },
    });
  });

  it('un 5xx sube igual (el terminal reintenta después)', async () => {
    sales.create.mockRejectedValue(new InternalServerErrorException('caída'));
    await expect(service.sync(dto(), user)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('número duplicado por otra venta: NUMERO_USADO', async () => {
    claims.create.mockRejectedValue({ code: 11000, keyPattern: { sedeId: 1, saleNumber: 1 } });
    await expect(service.sync(dto(), user)).rejects.toMatchObject({
      response: { reason: 'NUMERO_USADO' },
    });
  });

  it('fecha fuera de la reserva: FECHA_INVALIDA', async () => {
    const d = dto();
    d.soldAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await expect(service.sync(d, user)).rejects.toMatchObject({
      response: { reason: 'FECHA_INVALIDA' },
    });
  });

  it('sede ajena: 403 antes de mirar nada', async () => {
    const d = dto();
    d.sale.sedeId = new Types.ObjectId().toString();
    await expect(service.sync(d, user)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
