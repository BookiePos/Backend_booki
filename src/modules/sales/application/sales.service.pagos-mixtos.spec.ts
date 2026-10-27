import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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

import { SalesService } from './sales.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Pagos mixtos en un tiquete (ítem 6.9): efectivo + tarjeta, etc., sin dividir
 * la cuenta. Cada medio va a su cuenta del libro (Caja, Bancos, Clientes), la
 * tesorería recibe un movimiento por medio bancario y la parte fiada crea su
 * CxC o su deducción de nómina. El `payment` único sigue funcionando igual.
 *
 * La arepa vale $11.900 con IVA incluido; con propina de $1.100 el cobro es de
 * $13.000.
 */
describe('SalesService.create · pagos mixtos', () => {
  const sedeId = new Types.ObjectId();
  const PROD = new Types.ObjectId();
  const INV = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  /** Una arepa a $11.900 con IVA del 19 % incluido. */
  const catalogDb: Record<string, any> = {
    [PROD.toString()]: {
      _id: PROD,
      sku: 'A1',
      name: 'Arepa',
      unit: 'und',
      salePrice: 11_900,
      ivaType: 'gravado',
      ivaRate: 19,
      sourceType: 'inventory',
      inventoryProductId: INV,
      qtyPerUnit: 1,
    },
  };

  let creada: any;
  let ledger: any;
  let treasury: any;
  let receivableModel: any;
  let payroll: any;
  let deleteOne: any;
  let reverseSale: any;
  let sell: any;
  let service: SalesService;

  /** @param zona lo que devuelve `deliveryZones.refFor` */
  function build(zona: unknown = null) {
    creada = undefined;
    ledger = { postSale: vi.fn().mockResolvedValue(undefined) };
    treasury = { post: vi.fn().mockResolvedValue(undefined) };
    receivableModel = { create: vi.fn().mockResolvedValue({}) };
    payroll = {
      createDeduction: vi.fn().mockResolvedValue({}),
      assertEmpleadoParaConsumo: vi.fn().mockResolvedValue(undefined),
    };
    deleteOne = vi.fn(() => ({ exec: () => Promise.resolve({}) }));
    reverseSale = vi.fn().mockResolvedValue(undefined);
    sell = vi.fn((_s: string, lines: any[]) =>
      Promise.resolve(
        lines.map((l) => ({
          product: { _id: INV, sku: 'x', name: 'x', unit: 'und' },
          portions: [{ lot: { _id: new Types.ObjectId(), unitCost: 500 }, qty: l.qty }],
        })),
      ),
    );

    service = new SalesService(
      {
        create: vi.fn((doc: any) => {
          creada = { ...doc, _id: new Types.ObjectId() };
          return Promise.resolve(creada);
        }),
        deleteOne,
      } as never,
      {
        findOneAndUpdate: vi.fn(() => ({
          exec: () => Promise.resolve({ seq: 1 }),
        })),
      } as never,
      {
        find: vi.fn(() => ({
          exec: () => Promise.resolve([{ productId: INV, qty: 999 }]),
        })),
      } as never,
      {
        findOne: vi.fn(() => ({
          exec: () => Promise.resolve({ _id: new Types.ObjectId() }),
        })),
      } as never,
      {} as never, // discountModel
      receivableModel as never,
      { sell, reverseSale } as never,
      {} as never, // products
      { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) } as never,
      {
        loadSellableOrFail: vi.fn((id: string) => Promise.resolve(catalogDb[id])),
        // Ningún producto de esta prueba gasta empaque.
        packagingOf: vi.fn(() => []),
        componentsOf: vi.fn((p: any, qty: number) => [
          { productId: p.inventoryProductId.toString(), qty },
        ]),
      } as never,
      // Sin lista de precios: se cobra el precio de mostrador del catálogo.
      { rulesFor: vi.fn().mockResolvedValue(null) } as never,
      { refFor: vi.fn().mockResolvedValue(zona) } as never,
      {
        getOrFail: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(),
          name: 'Cliente',
          docType: 'CC',
          docNumber: '1',
        }),
      } as never, // customers
      payroll as never,
      { number: vi.fn().mockResolvedValue(30) } as never, // params
      ledger as never,
      treasury as never,
      {} as any, // sedeModel: solo lo recibe populate, que aquí está simulado
      {} as any, // tax: sin tenant restaurante no se consulta el INC
      {} as any, // businesses: el giro viene en el contexto o no hay tenant
      {} as any, // saleReturnModel: solo lo usa la anulación
      {} as any, // cajaMovementModel: solo lo usa la anulación
    );
  }

  function venta(extra: Record<string, unknown> = {}) {
    return {
      sedeId: sedeId.toString(),
      lines: [{ productId: PROD.toString(), qty: 1 }],
      ...extra,
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    build();
  });

  it('efectivo + tarjeta: guarda el reparto, cada medio a su cuenta y la tarjeta a tesorería', async () => {
    await service.create(
      venta({
        tip: 1_100,
        payments: [
          { method: 'cash', amount: 10_000 },
          { method: 'card', amount: 5_000 },
        ],
      }),
      user,
    );

    // El vuelto ($2.000) sale del efectivo: la parte guardada es neta.
    expect(creada.payments).toEqual([
      { method: 'cash', amount: 8_000 },
      { method: 'card', amount: 5_000 },
    ]);
    expect(creada.payment).toEqual({ method: 'cash', received: 10_000, change: 2_000 });

    const asiento = ledger.postSale.mock.calls[0][0];
    expect(asiento.payments).toEqual(creada.payments);
    expect(asiento.onCredit).toBe(false);

    expect(treasury.post).toHaveBeenCalledTimes(1);
    expect(treasury.post).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'card',
        amount: 5_000,
        sourceId: `${creada._id.toString()}:card`,
      }),
    );
  });

  it('tarjeta + transferencia: un movimiento de tesorería por medio', async () => {
    await service.create(
      venta({
        payments: [
          { method: 'transfer', amount: 6_900 },
          { method: 'card', amount: 5_000 },
        ],
      }),
      user,
    );
    const ids = treasury.post.mock.calls.map((c: any[]) => c[0].sourceId);
    expect(ids).toEqual([
      `${creada._id.toString()}:transfer`,
      `${creada._id.toString()}:card`,
    ]);
    // El medio que más cubrió queda en `payment.method` (factura electrónica).
    expect(creada.payment.method).toBe('transfer');
  });

  it('efectivo + Nequi + Daviplata (6.4): guarda canal y referencia, una cuenta de tesorería por canal', async () => {
    await service.create(
      venta({
        payments: [
          { method: 'cash', amount: 3_000 },
          { method: 'transfer', channel: 'nequi', reference: '3001234567', amount: 5_000 },
          { method: 'transfer', channel: 'daviplata', amount: 3_900 },
        ],
      }),
      user,
    );
    expect(creada.payments).toEqual([
      { method: 'cash', amount: 3_000 },
      { method: 'transfer', channel: 'nequi', reference: '3001234567', amount: 5_000 },
      { method: 'transfer', channel: 'daviplata', amount: 3_900 },
    ]);
    const posts = treasury.post.mock.calls.map((c: any[]) => c[0]);
    expect(posts.map((p: any) => p.channel)).toEqual(['nequi', 'daviplata']);
    expect(new Set(posts.map((p: any) => p.sourceId)).size).toBe(2);
    // El efectivo no se va a tesorería: queda en la caja del POS.
    expect(posts.every((p: any) => p.method === 'transfer')).toBe(true);
    // El asiento sigue leyendo el medio de siempre.
    expect(ledger.postSale.mock.calls[0][0].payments).toEqual(creada.payments);
  });

  it('un solo pago con datáfono (6.4): payment lleva franquicia y aprobación', async () => {
    await service.create(
      venta({
        payment: {
          method: 'card',
          channel: 'datafono',
          cardType: 'credit',
          franchise: 'visa',
          reference: 'AP 123456',
        },
      }),
      user,
    );
    expect(creada.payments).toBeUndefined();
    expect(creada.payment).toEqual(
      expect.objectContaining({
        method: 'card',
        channel: 'datafono',
        cardType: 'credit',
        franchise: 'visa',
        reference: 'AP 123456',
      }),
    );
    expect(treasury.post).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'datafono', sourceId: creada._id.toString() }),
    );
  });

  it('un canal que no es del medio: 400 antes de tocar el inventario', async () => {
    await expect(
      service.create(venta({ payment: { method: 'card', channel: 'qr' } }), user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sell).not.toHaveBeenCalled();
  });

  it('suma insuficiente: 400 antes de tocar el inventario', async () => {
    await expect(
      service.create(
        venta({
          payments: [
            { method: 'cash', amount: 5_000 },
            { method: 'card', amount: 5_000 },
          ],
        }),
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sell).not.toHaveBeenCalled();
    expect(creada).toBeUndefined();
  });

  it('vuelto con tarjeta: 400 antes de tocar el inventario', async () => {
    await expect(
      service.create(
        venta({
          payments: [
            { method: 'card', amount: 15_000 },
            { method: 'cash', amount: 1_000 },
          ],
        }),
        user,
      ),
    ).rejects.toThrow(/vuelto solo sale del efectivo/);
    expect(sell).not.toHaveBeenCalled();
  });

  it('mandar payment y payments a la vez es un error', async () => {
    await expect(
      service.create(
        venta({
          payment: { method: 'cash' },
          payments: [{ method: 'cash', amount: 20_000 }],
        }),
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sell).not.toHaveBeenCalled();
  });

  it('parte fiada a un cliente: la CxC es solo por esa parte', async () => {
    await service.create(
      venta({
        payments: [
          {
            method: 'credit',
            amount: 7_900,
            debtorType: 'customer',
            customerId: new Types.ObjectId().toString(),
          },
          { method: 'cash', amount: 4_000 },
        ],
      }),
      user,
    );
    expect(receivableModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7_900 }),
    );
    expect(payroll.createDeduction).not.toHaveBeenCalled();
    expect(ledger.postSale.mock.calls[0][0].payments).toEqual([
      { method: 'credit', amount: 7_900 },
      { method: 'cash', amount: 4_000 },
    ]);
    expect(treasury.post).not.toHaveBeenCalled();
  });

  it('parte fiada a un empleado: la deducción es solo por esa parte', async () => {
    await service.create(
      venta({
        payments: [
          { method: 'card', amount: 1_900 },
          {
            method: 'credit',
            amount: 10_000,
            debtorType: 'employee',
            employeeId: new Types.ObjectId().toString(),
          },
        ],
      }),
      user,
    );
    expect(payroll.assertEmpleadoParaConsumo).toHaveBeenCalledTimes(1);
    expect(payroll.createDeduction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10_000 }),
      user,
      { sinAlcanceDeSede: true },
    );
    expect(receivableModel.create).not.toHaveBeenCalled();
  });

  it('parte fiada sin deudor: 400 antes de tocar el inventario', async () => {
    await expect(
      service.create(
        venta({
          payments: [
            { method: 'credit', amount: 5_000 },
            { method: 'cash', amount: 6_900 },
          ],
        }),
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sell).not.toHaveBeenCalled();
  });

  it('compatibilidad: el payment único sigue igual (sin reparto, tesorería con el id de la venta)', async () => {
    await service.create(venta({ payment: { method: 'card' } }), user);

    expect(creada.payments).toBeUndefined();
    expect(creada.payment).toEqual({ method: 'card', received: undefined, change: undefined });
    const asiento = ledger.postSale.mock.calls[0][0];
    expect(asiento.payments).toBeUndefined();
    expect(asiento.paymentMethod).toBe('card');
    expect(treasury.post).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: creada._id.toString(), amount: 11_900 }),
    );
  });

  it('compatibilidad: efectivo único con recibido calcula el vuelto como siempre', async () => {
    await service.create(
      venta({ payment: { method: 'cash', received: 20_000 } }),
      user,
    );
    expect(creada.payment).toEqual({ method: 'cash', received: 20_000, change: 8_100 });
    expect(creada.payments).toBeUndefined();
  });

  it('un reparto de un solo medio se guarda como el pago de siempre', async () => {
    await service.create(
      venta({ payments: [{ method: 'cash', amount: 20_000 }] }),
      user,
    );
    expect(creada.payments).toBeUndefined();
    expect(creada.payment).toEqual({ method: 'cash', received: 20_000, change: 8_100 });
    expect(ledger.postSale.mock.calls[0][0].payments).toBeUndefined();
  });
});
