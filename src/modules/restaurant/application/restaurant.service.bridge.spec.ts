import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata de tipo para los @Prop() con uniones de
// literales, y @nestjs/mongoose lanza al no poder inferir el tipo cuando se
// importan los esquemas. Estos tests no usan los esquemas reales (modelos
// mockeados): neutralizamos decoradores/SchemaFactory para importar el servicio.
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

import { RestaurantService } from './restaurant.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Puente restaurante → POS: RestaurantService.sendToCaja y reconcileFromPos.
 * Servicio instanciado DIRECTAMENTE con mocks. Constructor (orden):
 *   tables, orders, counterModel, params, tax, posOrders
 *
 * getOrder() usa `this.orders.findById(id).exec()`, valida sede con
 * `order.sedeId.toString()` y reconcilia; por eso el doc de comanda expone
 * sedeId con toString(), y save()/set() como mocks.
 */
describe('RestaurantService puente restaurante → POS', () => {
  const sedeId = new Types.ObjectId();
  const orderObjId = new Types.ObjectId();
  const tableId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'mesero@erp.local',
    name: 'Mesero',
    role: 'Dueño',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  function comandaDoc(overrides: Record<string, any> = {}) {
    return {
      _id: orderObjId,
      id: orderObjId.toString(),
      number: 'CMD-000001',
      sedeId, // ObjectId → toString() disponible
      tableId,
      tableName: 'Mesa 1',
      status: 'open',
      posOrderId: undefined,
      tipAmount: 0,
      incRate: 8,
      tipRate: 10,
      tipAccepted: true,
      items: [],
      save: vi.fn().mockResolvedValue(undefined),
      set: vi.fn(),
      ...overrides,
    };
  }

  let tables: any;
  let orders: any;
  let posOrders: any;
  let service: RestaurantService;

  function build(doc: any) {
    orders = {
      findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve(doc) }),
    };
    tables = {
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
    };
    posOrders = {
      open: vi
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId() }),
      getOrFail: vi.fn(),
    };
    service = new RestaurantService(
      tables,
      orders,
      {} as any, // counterModel
      {} as any, // params
      {} as any, // tax
      posOrders,
    );
    return doc;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sendToCaja: ítem SIN productId (texto libre) → BadRequest mencionando el ítem y NO llama posOrders.open', async () => {
    const doc = build(
      comandaDoc({
        status: 'open',
        items: [
          { productId: new Types.ObjectId(), name: 'Bandeja', qty: 1, unitPrice: 100 },
          { name: 'Nota especial libre', qty: 1, unitPrice: 0 }, // sin productId
        ],
      }),
    );

    await expect(service.sendToCaja(doc.id, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.sendToCaja(doc.id, user)).rejects.toThrow(
      /Nota especial libre/,
    );
    expect(posOrders.open).not.toHaveBeenCalled();
  });

  it('sendToCaja: idempotente si ya tiene posOrderId → devuelve sin llamar posOrders.open', async () => {
    const existingPos = new Types.ObjectId();
    // status 'open' (no 'billed') para que reconcileFromPos sea no-op.
    const doc = build(
      comandaDoc({
        status: 'open',
        posOrderId: existingPos,
        items: [
          { productId: new Types.ObjectId(), name: 'Bandeja', qty: 1, unitPrice: 100 },
        ],
      }),
    );

    const result = await service.sendToCaja(doc.id, user);
    expect(posOrders.open).not.toHaveBeenCalled();
    expect(result.posOrderId).toBe(existingPos);
  });

  it('sendToCaja: camino feliz → abre cuenta POS con líneas {productId,qty}, estampa posOrderId + status billed y guarda', async () => {
    const p1 = new Types.ObjectId();
    const p2 = new Types.ObjectId();
    const posId = new Types.ObjectId();
    const doc = build(
      comandaDoc({
        status: 'open',
        items: [
          { productId: p1, name: 'Bandeja', qty: 2, unitPrice: 100 },
          { productId: p2, name: 'Jugo', qty: 1, unitPrice: 50 },
        ],
      }),
    );
    posOrders.open.mockResolvedValue({ _id: posId });

    const result = await service.sendToCaja(doc.id, user);

    expect(posOrders.open).toHaveBeenCalledTimes(1);
    const [posDto, calledUser, restaurantOrderId] = posOrders.open.mock.calls[0];
    expect(posDto.sedeId).toBe(sedeId.toString());
    expect(posDto.lines).toEqual([
      { productId: p1.toString(), qty: 2 },
      { productId: p2.toString(), qty: 1 },
    ]);
    expect(calledUser).toBe(user);
    expect(restaurantOrderId).toBe(orderObjId);

    expect(result.posOrderId).toBe(posId);
    expect(result.status).toBe('billed');
    expect(doc.save).toHaveBeenCalled();
    // Libera/marca la mesa como bill_requested.
    expect(tables.updateOne).toHaveBeenCalledWith(
      { _id: tableId },
      { status: 'bill_requested' },
    );
  });

  it('reconcileFromPos (vía getOrder): cuenta POS closed → comanda closed y libera la mesa', async () => {
    const posId = new Types.ObjectId();
    const closedAt = new Date();
    const doc = build(
      comandaDoc({ status: 'billed', posOrderId: posId }),
    );
    posOrders.getOrFail.mockResolvedValue({ status: 'closed', closedAt });

    const result = await service.getOrder(doc.id, user);

    expect(result.status).toBe('closed');
    expect(result.closedAt).toBe(closedAt);
    // freeTable → tables.updateOne con status free.
    expect(tables.updateOne).toHaveBeenCalledWith(
      { _id: tableId },
      { status: 'free', currentOrderId: null },
    );
    expect(doc.save).toHaveBeenCalled();
  });

  it('reconcileFromPos (vía getOrder): cuenta POS void → comanda vuelve a open y limpia posOrderId', async () => {
    const posId = new Types.ObjectId();
    const doc = build(
      comandaDoc({ status: 'billed', posOrderId: posId }),
    );
    posOrders.getOrFail.mockResolvedValue({ status: 'void' });

    const result = await service.getOrder(doc.id, user);

    expect(result.status).toBe('open');
    // set('posOrderId', undefined) para permitir reenviar.
    expect(doc.set).toHaveBeenCalledWith('posOrderId', undefined);
    expect(doc.save).toHaveBeenCalled();
  });
});
