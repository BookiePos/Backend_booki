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
 * Empaque: la bolsa, el vaso, la cuchara que se gastan al vender.
 *
 * Hasta ahora solo bajaban cuando alguien se acordaba de hacer un ajuste a
 * mano, así que el número se iba desviando y el margen de cada producto salía
 * mejor de lo que era: la bolsa no aparecía por ningún lado.
 *
 * Lo que se protege aquí es una regla que parece menor y no lo es: **el empaque
 * nunca puede tumbar una venta**. Si el sistema cree que no hay bolsas, casi
 * siempre es que alguien no registró la compra y las bolsas están ahí; no poder
 * cobrar una galleta por eso sería mucho peor que el descuadre. La mercancía sí
 * bloquea —esa sí falta de verdad— y esa diferencia es todo el diseño.
 *
 * Constructor (orden):
 *   saleModel, counterModel, stockItemModel, cajaSessionModel, discountModel,
 *   receivableModel, stock, products, sedes, catalog, priceLists, deliveryZones,
 *   customers, payroll, params, ledgerPosting, treasury
 */
describe('SalesService.create · empaque', () => {
  const sedeId = new Types.ObjectId();
  const GALLETA = new Types.ObjectId(); // producto vendible
  const INV_GALLETA = new Types.ObjectId(); // la galleta en inventario
  const BOLSA = new Types.ObjectId();
  const STICKER = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let vendido: { productId: string; qty: number }[];
  let service: SalesService;

  /**
   * @param existencias cuánto hay de cada ítem de inventario
   * @param empaque qué gasta cada galleta vendida
   */
  function build(
    existencias: Record<string, number>,
    empaque: { productId: string; qty: number }[],
  ) {
    vendido = []

    service = new SalesService(
      {
        create: vi.fn((doc: any) =>
          Promise.resolve({ ...doc, _id: new Types.ObjectId() }),
        ),
      } as never,
      {
        findOneAndUpdate: vi.fn(() => ({
          exec: () => Promise.resolve({ seq: 1 }),
        })),
      } as never,
      {
        find: vi.fn(() => ({
          exec: () =>
            Promise.resolve(
              Object.entries(existencias).map(([productId, qty]) => ({
                productId: new Types.ObjectId(productId),
                qty,
              })),
            ),
        })),
      } as never,
      {
        findOne: vi.fn(() => ({
          exec: () => Promise.resolve({ _id: new Types.ObjectId() }),
        })),
      } as never,
      {} as never, // discountModel
      {} as never, // receivableModel
      {
        sell: vi.fn((_s: string, lines: any[]) => {
          vendido = lines.map((l) => ({ productId: l.productId, qty: l.qty }))
          return Promise.resolve(
            lines.map((l) => ({
              product: { _id: new Types.ObjectId(l.productId), sku: 'x', name: 'x', unit: 'und' },
              portions: [
                { lot: { _id: new Types.ObjectId(), unitCost: 100 }, qty: l.qty },
              ],
            })),
          )
        }),
      } as never,
      { getOrFail: vi.fn().mockResolvedValue({ name: 'Galleta' }) } as never,
      { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) } as never,
      {
        loadSellableOrFail: vi.fn().mockResolvedValue({
          _id: GALLETA,
          sku: 'G1',
          name: 'Galleta',
          salePrice: 3_000,
          ivaType: 'gravado',
          ivaRate: 19,
          sourceType: 'inventory',
          inventoryProductId: INV_GALLETA,
          qtyPerUnit: 1,
        }),
        componentsOf: vi.fn((p: any, qty: number) => [
          { productId: p.inventoryProductId.toString(), qty },
        ]),
        packagingOf: vi.fn((_p: unknown, qty: number) =>
          empaque.map((e) => ({ productId: e.productId, qty: e.qty * qty })),
        ),
      } as never,
      { rulesFor: vi.fn().mockResolvedValue(null) } as never,
      { refFor: vi.fn().mockResolvedValue(null) } as never,
      {} as never, // customers
      {} as never, // payroll
      {} as never, // params
      { postSale: vi.fn().mockResolvedValue(undefined) } as never,
      { post: vi.fn().mockResolvedValue(undefined) } as never,
    );
  }

  function venta(extra: Record<string, unknown> = {}) {
    return {
      sedeId: sedeId.toString(),
      lines: [{ productId: GALLETA.toString(), qty: 2 }],
      payment: { method: 'cash', received: 100_000 },
      ...extra,
    } as never;
  }

  /** Cuánto se descontó de un ítem de inventario. */
  function gastado(id: Types.ObjectId): number {
    return vendido.find((v) => v.productId === id.toString())?.qty ?? 0
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('descuenta el empaque del producto además de la mercancía', async () => {
    build(
      { [INV_GALLETA.toString()]: 100, [BOLSA.toString()]: 50 },
      [{ productId: BOLSA.toString(), qty: 1 }],
    );

    await service.create(venta(), user);

    expect(gastado(INV_GALLETA)).toBe(2);
    expect(gastado(BOLSA)).toBe(2); // una bolsa por galleta
  });

  it('la falta de empaque NO tumba la venta: se gasta hasta donde alcance', async () => {
    // La regla que da sentido a todo esto. Hay 1 bolsa registrada y se venden
    // 2 galletas: la venta pasa, se gasta la bolsa que hay y el inventario
    // queda en cero en vez de irse a negativo.
    build(
      { [INV_GALLETA.toString()]: 100, [BOLSA.toString()]: 1 },
      [{ productId: BOLSA.toString(), qty: 1 }],
    );

    await service.create(venta(), user);

    expect(gastado(INV_GALLETA)).toBe(2);
    expect(gastado(BOLSA)).toBe(1);
  });

  it('sin nada de empaque registrado, la venta pasa igual y no se descuenta', async () => {
    build({ [INV_GALLETA.toString()]: 100 }, [
      { productId: BOLSA.toString(), qty: 1 },
    ]);

    await service.create(venta(), user);

    expect(gastado(INV_GALLETA)).toBe(2);
    expect(gastado(BOLSA)).toBe(0);
  });

  it('la MERCANCÍA sí bloquea: esa sí falta de verdad', async () => {
    // La diferencia con el empaque es el diseño entero. Si no hay galletas, no
    // hay nada que vender; si no hay bolsas, casi seguro sí las hay.
    build({ [INV_GALLETA.toString()]: 1 }, []);

    await expect(service.create(venta(), user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('el empaque anotado a mano al cobrar también se descuenta', async () => {
    // La bolsa grande porque el cliente se llevó todo junto.
    build(
      {
        [INV_GALLETA.toString()]: 100,
        [BOLSA.toString()]: 50,
        [STICKER.toString()]: 10,
      },
      [{ productId: BOLSA.toString(), qty: 1 }],
    );

    await service.create(
      venta({ packaging: [{ productId: STICKER.toString(), qty: 3 }] }),
      user,
    );

    expect(gastado(BOLSA)).toBe(2); // el del producto
    expect(gastado(STICKER)).toBe(3); // el anotado a mano
  });

  it('el empaque no se le cobra al cliente: el total no cambia', async () => {
    // Sale del inventario y entra al costo, pero no es una línea de venta.
    build(
      { [INV_GALLETA.toString()]: 100, [BOLSA.toString()]: 50 },
      [{ productId: BOLSA.toString(), qty: 1 }],
    );

    const conEmpaque = await service.create(venta(), user);

    build({ [INV_GALLETA.toString()]: 100 }, []);
    const sinEmpaque = await service.create(venta(), user);

    expect(conEmpaque.total).toBe(sinEmpaque.total);
    expect(conEmpaque.total).toBe(6_000); // 2 × 3.000
  });

  it('lo anotado a mano se suma a lo del producto si es el mismo empaque', async () => {
    build(
      { [INV_GALLETA.toString()]: 100, [BOLSA.toString()]: 50 },
      [{ productId: BOLSA.toString(), qty: 1 }],
    );

    await service.create(
      venta({ packaging: [{ productId: BOLSA.toString(), qty: 1 }] }),
      user,
    );

    // Dos del producto más una suelta, en un solo descuento.
    expect(gastado(BOLSA)).toBe(3);
    expect(
      vendido.filter((v) => v.productId === BOLSA.toString()),
    ).toHaveLength(1);
  });

  it('un producto sin empaque definido se vende como siempre', async () => {
    build({ [INV_GALLETA.toString()]: 100 }, []);
    await service.create(venta(), user);
    expect(vendido).toHaveLength(1);
    expect(gastado(INV_GALLETA)).toBe(2);
  });
});
