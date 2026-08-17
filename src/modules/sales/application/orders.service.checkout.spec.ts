import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata de tipo para los @Prop() con uniones de
// literales (p.ej. `status: 'open' | 'closed'`), y @nestjs/mongoose lanza al
// no poder inferir el tipo cuando se importan los esquemas. Estos tests no usan
// los esquemas reales (los modelos van mockeados), así que neutralizamos los
// decoradores/SchemaFactory para poder importar el servicio.
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
 * Comportamiento de la guarda de concurrencia en OrdersService.checkout.
 * Se instancia el servicio DIRECTAMENTE con dependencias mockeadas (sin DI de
 * Nest ni Mongo real). El constructor es:
 *   (orderModel, counterModel, cajaSessionModel, sedes, catalog, sales)
 */
describe('OrdersService.checkout (guarda de concurrencia)', () => {
  const sedeId = new Types.ObjectId();
  const orderObjId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@erp.local',
    name: 'Cajero',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  // Documento de orden 'open' devuelto por getOrFail (findById...populate...exec).
  // sedeId viene "populado" como objeto con _id (sedeIdOf lo lee así).
  function openOrderDoc() {
    return {
      _id: orderObjId,
      id: orderObjId.toString(),
      status: 'open',
      sedeId: { _id: sedeId, code: 'S1', name: 'Sede 1' },
      lines: [
        { productId: new Types.ObjectId(), qty: 2 },
      ],
    };
  }

  const dto = { payment: { method: 'cash' as const } } as any;

  let orderModel: any;
  let counterModel: any;
  let cajaSessionModel: any;
  let sedes: any;
  let catalog: any;
  let sales: any;
  let service: OrdersService;

  beforeEach(() => {
    orderModel = {
      findById: vi.fn().mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(openOrderDoc()) }),
      }),
      findOneAndUpdate: vi
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve(openOrderDoc()) }),
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
    };
    counterModel = {};
    cajaSessionModel = {};
    sedes = {};
    catalog = {};
    sales = {
      create: vi
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId() }),
    };
    service = new OrdersService(
      orderModel,
      counterModel,
      cajaSessionModel,
      sedes,
      catalog,
      sales,
    );
  });

  it('lanza ConflictException y NO crea la venta si el flip open→closed devuelve null', async () => {
    // Otro proceso ya cobró: el findOneAndUpdate condicional no encuentra la
    // cuenta abierta.
    orderModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(null),
    });

    await expect(service.checkout(orderObjId.toString(), dto, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(sales.create).not.toHaveBeenCalled();
    // No debe intentar enlazar ninguna venta.
    expect(orderModel.updateOne).not.toHaveBeenCalled();
  });

  it('camino feliz: crea la venta una vez y enlaza el saleId a la cuenta cerrada', async () => {
    const saleId = new Types.ObjectId();
    sales.create.mockResolvedValue({ _id: saleId });

    const result = await service.checkout(orderObjId.toString(), dto, user);

    expect(sales.create).toHaveBeenCalledTimes(1);
    // Se enlaza el saleId con updateOne.
    expect(orderModel.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = orderModel.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: orderObjId });
    expect(update).toEqual({ $set: { saleId } });
    expect(result).toMatchObject({ _id: saleId });
  });

  it('si sales.create lanza: revierte la cuenta a open y propaga el error', async () => {
    const boom = new Error('inventario insuficiente');
    sales.create.mockRejectedValue(boom);

    await expect(
      service.checkout(orderObjId.toString(), dto, user),
    ).rejects.toBe(boom);

    // Se libera la cuenta (status open) para reintentar el cobro.
    expect(orderModel.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = orderModel.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: orderObjId });
    expect(update).toMatchObject({ $set: { status: 'open' } });
    expect(update.$unset).toHaveProperty('closedAt');
  });
});
