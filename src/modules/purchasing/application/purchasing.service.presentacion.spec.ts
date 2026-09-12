import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
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

import { PurchasingService } from './purchasing.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Comprar en la presentación del proveedor.
 *
 * La factura dice "3 BULTOS HARINA $285.000" y hasta ahora tocaba traducirla a
 * mano a "75.000 G a $3,80". Traducir a mano es donde se equivoca la gente, y
 * el error no avisa:
 *
 * - Registrar 3 en vez de 75.000 deja el inventario en nada y dispara alertas
 *   de reposición falsas al día siguiente.
 * - Registrar $95.000 como costo del GRAMO infla cada receta veinticinco mil
 *   veces, en silencio, hasta que alguien mira un margen.
 *
 * La plata no cambia —3 × 95.000 es lo mismo que 75.000 × 3,80— así que la
 * orden de compra, la cuenta por pagar y el asiento salen iguales. Lo único que
 * cambia es lo que entra al inventario al recibir.
 *
 * Constructor:
 *   (orders, payables, counterModel, stock, products, tax, ledgerPosting)
 */
describe('PurchasingService · compra en presentación', () => {
  const sedeId = new Types.ObjectId();
  const HARINA = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'compras@bookipos.local',
    name: 'Compras',
    role: 'admin',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  /** Harina: se consume en gramos y se compra en bultos de 25 kg. */
  function harina(overrides: Record<string, unknown> = {}) {
    return {
      _id: HARINA,
      name: 'Harina',
      unit: 'g',
      purchaseUnit: 'bulto',
      purchaseFactor: 25_000,
      ...overrides,
    };
  }

  let creada: any;
  let stock: any;
  let service: PurchasingService;

  function build(product: unknown = harina()) {
    creada = undefined;
    stock = { entry: vi.fn().mockResolvedValue(undefined) };

    service = new PurchasingService(
      {
        create: vi.fn((doc: any) => {
          creada = { ...doc, _id: new Types.ObjectId() };
          return Promise.resolve(creada);
        }),
      } as never,
      {} as never, // payables
      {
        findOneAndUpdate: vi.fn(() => ({
          exec: () => Promise.resolve({ seq: 1 }),
        })),
      } as never,
      stock as never,
      {
        getOrFail: vi.fn(() => {
          if (!product) return Promise.reject(new Error('no existe'));
          return Promise.resolve(product);
        }),
      } as never,
      { compute: vi.fn().mockResolvedValue({ taxAmount: 0 }) } as never,
      {
        postPurchase: vi.fn(),
        postPurchaseReceipt: vi.fn().mockResolvedValue(undefined),
      } as never,
    );
  }

  /** Orden de 3 bultos a $95.000 el bulto. */
  function orden(extra: Record<string, unknown> = {}) {
    return {
      sedeId: sedeId.toString(),
      supplierName: 'Molinos del Valle',
      issueDate: '2026-09-12',
      lines: [
        {
          productId: HARINA.toString(),
          description: 'HARINA DE TRIGO',
          qty: 3,
          unitCost: 95_000,
          inPurchaseUnits: true,
        },
      ],
      ...extra,
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('la orden se lee como la factura: 3 bultos a $95.000', async () => {
    build();
    await service.create(orden(), user);

    expect(creada.lines[0].qty).toBe(3);
    expect(creada.lines[0].unitCost).toBe(95_000);
    expect(creada.lines[0].inPurchaseUnits).toBe(true);
    expect(creada.subtotal).toBe(285_000);
  });

  it('congela la presentación en el renglón, no la deja colgando del producto', async () => {
    // Si mañana alguien le cambia la presentación a la harina, esta orden tiene
    // que seguir diciendo lo que se pidió y a qué precio.
    build();
    await service.create(orden(), user);

    expect(creada.lines[0].purchaseUnit).toBe('bulto');
    expect(creada.lines[0].purchaseFactor).toBe(25_000);
  });

  it('un producto sin presentación definida es 400, no factor 1', async () => {
    // Asumir factor 1 metería 3 gramos de harina y dejaría el inventario en
    // nada, sin que nada avise.
    build(harina({ purchaseUnit: undefined, purchaseFactor: undefined }));

    await expect(service.create(orden(), user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('un renglón sin producto enlazado tampoco puede venir en bultos', async () => {
    build();
    await expect(
      service.create(
        orden({
          lines: [
            {
              description: 'HARINA',
              qty: 3,
              unitCost: 95_000,
              inPurchaseUnits: true,
            },
          ],
        }),
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('al recibir, el inventario convierte: entran 75.000 g, no 3', async () => {
    // Es el paso donde la equivocación se paga. La orden habla en bultos y el
    // inventario en gramos; quien traduce es `StockService.entry`, con la marca
    // que el renglón trae.
    build();
    const po: any = {
      _id: new Types.ObjectId(),
      id: 'oc1',
      number: 'OC-000001',
      sedeId,
      supplierName: 'Molinos del Valle',
      status: 'sent',
      lines: [
        {
          productId: HARINA,
          description: 'HARINA DE TRIGO',
          qty: 3,
          qtyReceived: 0,
          unitCost: 95_000,
          inPurchaseUnits: true,
        },
      ],
      receipts: [],
      save: vi.fn().mockResolvedValue(undefined),
      markModified: vi.fn(),
    };
    const orders: any = (service as never as { orders: unknown }).orders;
    orders.findById = vi.fn(() => ({ exec: () => Promise.resolve(po) }));
    orders.findOneAndUpdate = vi.fn(() => ({
      exec: () => Promise.resolve(po),
    }));
    orders.updateOne = vi.fn(() => ({ exec: () => Promise.resolve({}) }));

    await service.receive(
      'oc1',
      { date: '2026-09-12', lines: [{ lineIndex: 0, qty: 3 }] } as never,
      user,
    );

    expect(stock.entry).toHaveBeenCalledTimes(1);
    const entrada = stock.entry.mock.calls[0][0];
    expect(entrada.qty).toBe(3);
    expect(entrada.unitCost).toBe(95_000);
    // La marca es lo que hace que el inventario convierta a 75.000 g a $3,80.
    expect(entrada.inPurchaseUnits).toBe(true);
  });

  it('una compra normal sigue igual: sin presentación y sin marca', async () => {
    build();
    await service.create(
      orden({
        lines: [
          {
            productId: HARINA.toString(),
            description: 'HARINA',
            qty: 75_000,
            unitCost: 4,
          },
        ],
      }),
      user,
    );

    expect(creada.lines[0].inPurchaseUnits).toBe(false);
    expect(creada.lines[0].purchaseUnit).toBeUndefined();
    expect(creada.subtotal).toBe(300_000);
  });
});
