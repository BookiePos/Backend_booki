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
  let saldoFavor: any;
  let saldo: number;

  /** @param zona lo que devuelve `deliveryZones.refFor` */
  function build(zona: unknown = null) {
    creada = undefined;
    saldo = 20_000;
    saldoFavor = {
      saldoDe: vi.fn(async () => saldo),
      consumir: vi.fn(async (o: any) => {
        if (o.amount > saldo) throw new ConflictException('saldo insuficiente');
        saldo -= o.amount;
      }),
    };
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
      undefined, // notas
      saldoFavor as never,
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

  const CLIENTE = new Types.ObjectId().toString();

  it('todo con saldo a favor: lo gasta con la venta ya creada y el asiento va con saldo_favor (2805)', async () => {
    await service.create(venta({ customerId: CLIENTE, payment: { method: 'saldo_favor' } }), user);
    expect(saldoFavor.consumir).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CLIENTE, amount: 11_900, saleId: creada._id.toString() }),
    );
    expect(saldo).toBe(8_100);
    expect(creada.customerId.toString()).toBe(CLIENTE);
    expect(ledger.postSale.mock.calls[0][0].paymentMethod).toBe('saldo_favor');
    // No es plata que entre a bancos.
    expect(treasury.post).not.toHaveBeenCalled();
  });

  it('mixto: solo la parte de saldo a favor sale del saldo; el resto en efectivo', async () => {
    await service.create(
      venta({
        customerId: CLIENTE,
        payments: [
          { method: 'saldo_favor', amount: 5_000 },
          { method: 'cash', amount: 10_000 },
        ],
      }),
      user,
    );
    expect(saldoFavor.consumir.mock.calls[0][0].amount).toBe(5_000);
    expect(ledger.postSale.mock.calls[0][0].payments).toEqual(
      expect.arrayContaining([{ method: 'saldo_favor', amount: 5_000 }]),
    );
  });

  it('no alcanza el saldo: 400 antes de tocar inventario', async () => {
    saldo = 1_000;
    await expect(
      service.create(venta({ customerId: CLIENTE, payment: { method: 'saldo_favor' } }), user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sell).not.toHaveBeenCalled();
  });

  it('sin cliente registrado: 400', async () => {
    await expect(service.create(venta({ payment: { method: 'saldo_favor' } }), user)).rejects.toThrow(/cliente registrado/);
    expect(sell).not.toHaveBeenCalled();
  });

  it('otro cobro gastó el saldo entretanto: se deshace la venta, vuelve el stock y no hay asiento', async () => {
    saldoFavor.saldoDe.mockResolvedValueOnce(20_000);
    saldo = 0;
    await expect(
      service.create(venta({ customerId: CLIENTE, payment: { method: 'saldo_favor' } }), user),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(deleteOne).toHaveBeenCalled();
    expect(reverseSale).toHaveBeenCalled();
    expect(ledger.postSale).not.toHaveBeenCalled();
  });
});
