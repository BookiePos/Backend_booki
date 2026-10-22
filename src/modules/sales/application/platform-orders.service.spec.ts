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

import { PlatformOrdersService } from './platform-orders.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const q = <T>(v: T) => {
  const chain: any = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    exec: () => Promise.resolve(v),
  };
  return chain;
};

describe('PlatformOrdersService · importación de pedidos (7.5)', () => {
  const sedeId = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'c@x.co',
    role: 'cashier',
    permissions: ['pos.sell'],
    sedeIds: [sedeId.toString()],
  } as unknown as JwtUser;
  const csv = [
    'Pedido;Fecha;Producto;SKU;Cantidad;Comision;Total',
    'R-1;05/10/2026;Hamburguesa;HAM-1;2;4000;40000',
    'R-1;05/10/2026;Gaseosa;GAS-1;1;;',
    'R-2;05/10/2026;Pizza;;1;;',
    'R-3;06/10/2026;Gaseosa;;1;;',
  ].join('\n');

  let saleModel: any;
  let create: any;
  let cajaAbierta: unknown;
  let existentes: any[];
  let service: PlatformOrdersService;

  function build() {
    existentes = [];
    cajaAbierta = { _id: new Types.ObjectId() };
    saleModel = { find: vi.fn(() => q(existentes)), aggregate: vi.fn() };
    create = vi.fn((d: any) => Promise.resolve({ saleNumber: `FV-${d.platform.externalId}` }));
    service = new PlatformOrdersService(
      saleModel,
      {} as never,
      { findOne: vi.fn(() => q(cajaAbierta)) } as never,
      {
        listSellable: vi.fn().mockResolvedValue([
          { id: 'p1', sku: 'HAM-1', name: 'Hamburguesa', salePrice: 20_000 },
          { id: 'p2', sku: 'GAS-1', name: 'Gaseosa', salePrice: 4_000 },
        ]),
      } as never,
      { create } as never,
    );
  }
  const dto = (extra: Record<string, unknown> = {}) =>
    ({ sedeId: sedeId.toString(), platform: 'rappi', csv, ...extra }) as never;

  beforeEach(build);

  it('vista previa: empareja por SKU/nombre, avisa total distinto y marca errores por pedido', async () => {
    const r = await service.preview(dto(), user);
    const [r1, r2, r3] = r.orders;
    expect(r1).toMatchObject({
      externalId: 'R-1',
      status: 'ok',
      total: 44_000,
      commissionEstimate: 4_000,
    });
    expect(r1!.warnings[0]).toMatch(/no coincide/);
    expect(r2!.status).toBe('error');
    expect(r2!.errors[0]).toMatch(/Pizza/);
    expect(r3).toMatchObject({ status: 'ok', total: 4_000 });
    expect(r.summary).toEqual({ ok: 2, duplicado: 0, error: 1 });
  });

  it('IDEMPOTENCIA: lo ya registrado sale duplicado y no se vuelve a vender', async () => {
    existentes = [{ saleNumber: 'FV-000050', platform: { externalId: 'R-1' } }];
    const r = await service.import(dto(), user);
    expect(r.results.find((x) => x.externalId === 'R-1')).toMatchObject({
      status: 'duplicado',
      saleNumber: 'FV-000050',
    });
    expect(create).toHaveBeenCalledTimes(1); // solo R-3
    expect(create.mock.calls[0][0]).toMatchObject({
      payment: { method: 'platform' },
      platform: { code: 'rappi', externalId: 'R-3' },
    });
    expect(r.summary).toEqual({ creado: 1, duplicado: 1, error: 1 });
  });

  it('el precio nunca viaja desde el CSV: la venta solo recibe productos y cantidades', async () => {
    await service.import(dto(), user);
    for (const [arg] of create.mock.calls) {
      expect(arg.lines.every((l: any) => Object.keys(l).sort().join() === 'productId,qty')).toBe(
        true,
      );
    }
  });

  it('un error al crear un pedido no frena a los demás; una carrera 409 cuenta como duplicado', async () => {
    // R-2 sale con error de producto; R-1 falla por stock y R-3 pierde la carrera.
    create
      .mockRejectedValueOnce(new BadRequestException('Stock insuficiente de Hamburguesa'))
      .mockRejectedValueOnce(new ConflictException({ message: 'ya está registrado', code: 'PEDIDO_PLATAFORMA_DUPLICADO' }));
    const r = await service.import(dto(), user);
    expect(r.results.map((x) => x.status)).toEqual(['error', 'error', 'duplicado']);
    expect(r.results[0]!.message).toMatch(/Stock insuficiente/);
  });

  it('sin caja abierta no importa nada', async () => {
    cajaAbierta = null;
    await expect(service.import(dto(), user)).rejects.toThrow(/abrir la caja/);
    expect(create).not.toHaveBeenCalled();
  });

  it('sede ajena: 403 sin leer nada', async () => {
    await expect(
      service.preview(dto({ sedeId: new Types.ObjectId().toString() }), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(saleModel.find).not.toHaveBeenCalled();
  });

  it('un CSV sin columnas obligatorias no crea nada', async () => {
    const r = await service.import(dto({ csv: 'Fecha;Total\n2026-10-01;1000' }), user);
    expect(r.results).toEqual([]);
    expect(r.summary.error).toBe(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('otro 409 (no el del pedido repetido) es error, no duplicado', async () => {
    create.mockRejectedValueOnce(new ConflictException('otro conflicto'));
    const r = await service.import(dto(), user);
    expect(r.results[0]!.status).toBe('error');
  });

  it('pedido con fecha futura sale con error en la vista previa', async () => {
    const r = await service.preview(
      dto({ csv: 'Pedido;Fecha;Producto;Cantidad\nF-1;2999-01-01;Gaseosa;1' }),
      user,
    );
    expect(r.orders[0]!.status).toBe('error');
    expect(r.orders[0]!.errors[0]).toMatch(/futura/);
  });

  it('los pendientes se piden sin el tope de 500', async () => {
    const limit = vi.fn(() => ({ select: () => ({ exec: () => Promise.resolve([]) }) }));
    saleModel.find = vi.fn(() => ({ sort: () => ({ limit }) }));
    await service.list({ sedeId: sedeId.toString(), pending: true }, user);
    expect(limit).toHaveBeenCalledWith(5000);
  });
});
