import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas de ventas.
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
 * Cobrar una cuenta dividida entre varios.
 *
 * El cálculo vive en el dominio y tiene sus pruebas; lo que se protege aquí es
 * lo que pasa contra la base, que es donde se pierde plata de verdad:
 *
 * - Que un cobro parcial DEJE la comanda abierta. Si la cerrara, lo que falta
 *   se queda sin cobrar y sale del inventario sin que nadie lo pague.
 * - Que dos meseros cobrando partes distintas de la misma mesa al mismo tiempo
 *   no puedan cobrar los dos lo mismo. Sin el bloqueo, ambos leen las mismas
 *   cantidades pendientes y la comanda nunca cierra.
 *
 * El constructor es:
 *   (orderModel, counterModel, cajaSessionModel, sedes, catalog, sales)
 */
describe('OrdersService.checkout · cuenta dividida', () => {
  const sedeId = new Types.ObjectId();
  const orderObjId = new Types.ObjectId();
  const PIZZA = new Types.ObjectId();
  const CERVEZA = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'mesero@bookipos.local',
    name: 'Mesero',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  /** Mesa con una pizza y cuatro cervezas, nada pagado todavía. */
  function comanda(overrides: Record<string, unknown> = {}) {
    return {
      _id: orderObjId,
      id: orderObjId.toString(),
      status: 'open',
      paymentSeq: 0,
      sedeId: { _id: sedeId, code: 'S1', name: 'Sede 1' },
      lines: [
        { productId: PIZZA, qty: 1, paidQty: 0 },
        { productId: CERVEZA, qty: 4, paidQty: 0 },
      ],
      ...overrides,
    };
  }

  let orderModel: any;
  let sales: any;
  let service: OrdersService;

  function build(doc: any = comanda(), claimOk = true) {
    orderModel = {
      findById: vi.fn(() => ({
        populate: () => ({ exec: () => Promise.resolve(doc) }),
      })),
      findOneAndUpdate: vi.fn(() => ({
        exec: () => Promise.resolve(claimOk ? doc : null),
      })),
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
    };
    sales = { create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }) };
    service = new OrdersService(
      orderModel,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sales,
    );
  }

  /** Lo que el servicio pidió escribir al "tomar" el cobro. */
  function claim() {
    return orderModel.findOneAndUpdate.mock.calls[0];
  }

  const pago = { method: 'cash' as const };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cobrar una parte DEJA la comanda abierta', async () => {
    // Si la cerrara, las tres cervezas que faltan saldrían del inventario sin
    // que nadie las pague.
    build();

    await service.checkout(
      orderObjId.toString(),
      {
        payment: pago,
        lines: [
          { productId: PIZZA.toString(), qty: 1 },
          { productId: CERVEZA.toString(), qty: 1 },
        ],
      } as never,
      user,
    );

    const [, update] = claim();
    expect(update.$set.status).toBeUndefined();
    expect(update.$set['lines.0.paidQty']).toBe(1);
    expect(update.$set['lines.1.paidQty']).toBe(1);
    // Solo se factura lo que se cobró, no la mesa entera.
    expect(sales.create.mock.calls[0][0].lines).toEqual([
      { productId: PIZZA.toString(), qty: 1 },
      { productId: CERVEZA.toString(), qty: 1 },
    ]);
  });

  it('el cobro que salda la cuenta sí la cierra', async () => {
    build(
      comanda({
        lines: [
          { productId: PIZZA, qty: 1, paidQty: 1 },
          { productId: CERVEZA, qty: 4, paidQty: 3 },
        ],
      }),
    );

    await service.checkout(
      orderObjId.toString(),
      { payment: pago, lines: [{ productId: CERVEZA.toString(), qty: 1 }] } as never,
      user,
    );

    const [, update] = claim();
    expect(update.$set.status).toBe('closed');
    expect(update.$set.closedAt).toBeInstanceOf(Date);
  });

  it('sin líneas se cobra todo lo que falte, y eso cierra la cuenta', async () => {
    // Es el cobro de siempre y también el último de una cuenta dividida: por
    // eso lo que no se pudo repartir exacto lo absorbe quien paga de último.
    build(
      comanda({
        lines: [
          { productId: PIZZA, qty: 1, paidQty: 1 },
          { productId: CERVEZA, qty: 4, paidQty: 1.5 },
        ],
      }),
    );

    await service.checkout(
      orderObjId.toString(),
      { payment: pago } as never,
      user,
    );

    expect(sales.create.mock.calls[0][0].lines).toEqual([
      { productId: CERVEZA.toString(), qty: 2.5 },
    ]);
    expect(claim()[1].$set.status).toBe('closed');
  });

  it('el cobro exige que nadie haya cobrado mientras tanto', async () => {
    // Dos meseros cobrando partes distintas al tiempo leerían las mismas
    // cantidades pendientes. El segundo tiene que perder.
    build(comanda({ paymentSeq: 7 }));

    await service.checkout(
      orderObjId.toString(),
      { payment: pago, lines: [{ productId: PIZZA.toString(), qty: 1 }] } as never,
      user,
    );

    const [filtro, update] = claim();
    expect(filtro).toEqual({
      _id: orderObjId,
      status: 'open',
      paymentSeq: 7,
    });
    expect(update.$set.paymentSeq).toBe(8);
  });

  it('si otro cobró primero, este falla con 409 y NO crea la venta', async () => {
    build(comanda(), false);

    await expect(
      service.checkout(
        orderObjId.toString(),
        { payment: pago, lines: [{ productId: PIZZA.toString(), qty: 1 }] } as never,
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sales.create).not.toHaveBeenCalled();
    expect(orderModel.updateOne).not.toHaveBeenCalled();
  });

  it('cobrar de más una línea es 400, antes de tocar nada', async () => {
    build();

    await expect(
      service.checkout(
        orderObjId.toString(),
        { payment: pago, lines: [{ productId: CERVEZA.toString(), qty: 6 }] } as never,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(sales.create).not.toHaveBeenCalled();
  });

  it('si la venta falla, lo tomado se devuelve y la cuenta vuelve a abrir', async () => {
    build(
      comanda({
        lines: [
          { productId: PIZZA, qty: 1, paidQty: 0 },
          { productId: CERVEZA, qty: 4, paidQty: 2 },
        ],
      }),
    );
    const boom = new Error('sin inventario');
    sales.create.mockRejectedValue(boom);

    await expect(
      service.checkout(
        orderObjId.toString(),
        { payment: pago, lines: [{ productId: PIZZA.toString(), qty: 1 }] } as never,
        user,
      ),
    ).rejects.toBe(boom);

    const [, update] = orderModel.updateOne.mock.calls[0];
    // Vuelve a como estaba: la pizza sin pagar y las dos cervezas que ya
    // estaban pagadas, intactas.
    expect(update.$set['lines.0.paidQty']).toBe(0);
    expect(update.$set['lines.1.paidQty']).toBe(2);
    expect(update.$set.status).toBe('open');
  });

  it('acumula todas las ventas de la cuenta, no solo la última', async () => {
    build();
    const saleId = new Types.ObjectId();
    sales.create.mockResolvedValue({ _id: saleId });

    await service.checkout(
      orderObjId.toString(),
      { payment: pago, lines: [{ productId: PIZZA.toString(), qty: 1 }] } as never,
      user,
    );

    const [, update] = orderModel.updateOne.mock.calls[0];
    expect(update.$push).toEqual({ saleIds: saleId });
    expect(update.$set).toEqual({ saleId });
  });
});
