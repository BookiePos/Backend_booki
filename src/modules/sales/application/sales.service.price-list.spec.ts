import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
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
 * Qué lista de precios cobra una venta.
 *
 * El punto de todo esto es que el precio del mayorista NO dependa de que el
 * cajero se acuerde de aplicarlo: si el cliente tiene lista asignada, se cobra
 * sola, sin permisos ni pasos extra.
 *
 * Y su reverso, que es el riesgo: elegir una lista A MANO sí es decidir cobrar
 * menos, así que pide el mismo permiso que un descuento. Sin eso, cualquier
 * cajero podría venderle a precio de mayorista a quien quisiera, venta por
 * venta, sin que quede nada raro en la tirilla.
 *
 * Constructor (orden):
 *   saleModel, counterModel, stockItemModel, cajaSessionModel, discountModel,
 *   receivableModel, stock, products, sedes, catalog, priceLists, deliveryZones,
 *   customers,
 *   payroll, params, ledgerPosting, treasury
 */
describe('SalesService.create · lista de precios', () => {
  const sedeId = new Types.ObjectId();
  const saleId = new Types.ObjectId();
  const listaMayorista = new Types.ObjectId();

  const PROD = new Types.ObjectId();
  const INV = new Types.ObjectId();

  /** Gaseosa de mostrador a $3.000 con IVA incluido. */
  const catalogDb: Record<string, any> = {
    [PROD.toString()]: {
      _id: PROD,
      sku: 'G1',
      name: 'Gaseosa',
      unit: 'und',
      salePrice: 3_000,
      ivaType: 'gravado',
      ivaRate: 19,
      sourceType: 'inventory',
      inventoryProductId: INV,
      qtyPerUnit: 1,
    },
  };

  function usuario(permisos: string[]): JwtUser {
    return {
      userId: 'u1',
      email: 'cajero@bookipos.local',
      name: 'Cajero',
      role: 'cashier',
      sedeIds: [sedeId.toString()],
      permissions: permisos,
    } as unknown as JwtUser;
  }

  let createdSale: any;
  let service: SalesService;

  /**
   * @param cliente lo que devuelve `customers.getOrFail` (con o sin lista)
   * @param reglas lo que devuelve `priceLists.rulesFor` para la lista pedida
   */
  function build(cliente: any, reglas: any) {
    createdSale = undefined;

    const saleModel = {
      create: vi.fn((doc: any) => {
        createdSale = { ...doc, _id: saleId };
        return Promise.resolve(createdSale);
      }),
    };
    const counterModel = {
      findOneAndUpdate: vi.fn(() => ({
        exec: () => Promise.resolve({ seq: 1 }),
      })),
    };
    const stockItemModel = {
      find: vi.fn(() => ({
        exec: () => Promise.resolve([{ productId: INV, qty: 999 }]),
      })),
    };
    const cajaSessionModel = {
      findOne: vi.fn(() => ({
        exec: () => Promise.resolve({ _id: new Types.ObjectId() }),
      })),
    };
    const stock = {
      sell: vi.fn((_sede: string, lines: any[]) =>
        Promise.resolve(
          lines.map((l) => ({
            product: { _id: INV, sku: 'x', name: 'x', unit: 'und' },
            portions: [
              { lot: { _id: new Types.ObjectId(), unitCost: 900 }, qty: l.qty },
            ],
          })),
        ),
      ),
    };
    const catalog = {
      loadSellableOrFail: vi.fn((id: string) => Promise.resolve(catalogDb[id])),
      componentsOf: vi.fn((product: any, qty: number) => [
        { productId: product.inventoryProductId.toString(), qty },
      ]),
    };

    service = new SalesService(
      saleModel as never,
      counterModel as never,
      stockItemModel as never,
      cajaSessionModel as never,
      {} as never, // discountModel
      {} as never, // receivableModel
      stock as never,
      {} as never, // products
      { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) } as never,
      catalog as never,
      { rulesFor: vi.fn().mockResolvedValue(reglas) } as never,
      // Sin domicilio: no hay zona que resolver.
      { refFor: vi.fn().mockResolvedValue(null) } as never,
      { getOrFail: vi.fn().mockResolvedValue(cliente) } as never,
      {} as never, // payroll
      {} as never, // params
      { postSale: vi.fn().mockResolvedValue(undefined) } as never,
      { post: vi.fn().mockResolvedValue(undefined) } as never,
    );
  }

  /** Venta de contado de `qty` gaseosas. */
  function venta(extra: Record<string, unknown> = {}) {
    return {
      sedeId: sedeId.toString(),
      lines: [{ productId: PROD.toString(), qty: 1 }],
      payment: { method: 'cash', received: 100_000 },
      ...extra,
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sin cliente ni lista se cobra el precio de mostrador', async () => {
    build(null, null);
    await service.create(venta(), usuario([]));
    expect(createdSale.lines[0].unitPrice).toBe(3_000);
  });

  it('la lista del cliente registrado se aplica SOLA, sin permisos extra', async () => {
    // Este es el punto de la funcionalidad: el precio pactado no depende de
    // que el cajero se acuerde. El usuario no tiene permiso de descuentos.
    build(
      { _id: new Types.ObjectId(), priceListId: listaMayorista },
      { discountPercent: 12, items: [] },
    );

    await service.create(
      venta({ customerId: new Types.ObjectId().toString() }),
      usuario([]),
    );

    expect(createdSale.lines[0].unitPrice).toBe(2_640);
  });

  it('funciona en venta de CONTADO, que es como paga casi siempre el mayorista', async () => {
    // `payment.customerId` solo existe para el fiado. Si la lista se resolviera
    // solo por ahí, la tienda que paga de contado seguiría pagando mostrador —
    // justo el caso que importa.
    build(
      { _id: new Types.ObjectId(), priceListId: listaMayorista },
      { discountPercent: 12, items: [] },
    );

    await service.create(
      venta({
        customerId: new Types.ObjectId().toString(),
        payment: { method: 'cash', received: 100_000 },
      }),
      usuario([]),
    );

    expect(createdSale.lines[0].unitPrice).toBe(2_640);
  });

  it('un cliente sin lista asignada paga mostrador', async () => {
    build({ _id: new Types.ObjectId(), priceListId: undefined }, null);
    await service.create(
      venta({ customerId: new Types.ObjectId().toString() }),
      usuario([]),
    );
    expect(createdSale.lines[0].unitPrice).toBe(3_000);
  });

  it('elegir la lista a mano SIN permiso de descuentos es 403', async () => {
    build(null, { discountPercent: 12, items: [] });

    await expect(
      service.create(
        venta({ priceListId: listaMayorista.toString() }),
        usuario([]),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('elegir la lista a mano CON permiso de descuentos sí aplica', async () => {
    build(null, { discountPercent: 12, items: [] });

    await service.create(
      venta({ priceListId: listaMayorista.toString() }),
      usuario(['pos.discount.authorize']),
    );

    expect(createdSale.lines[0].unitPrice).toBe(2_640);
  });

  it('el precio por cantidad se resuelve con la cantidad de la línea', async () => {
    build(
      { _id: new Types.ObjectId(), priceListId: listaMayorista },
      {
        items: [
          { catalogProductId: PROD.toString(), price: 2_500, minQty: 12 },
        ],
      },
    );

    await service.create(
      venta({
        customerId: new Types.ObjectId().toString(),
        lines: [{ productId: PROD.toString(), qty: 12 }],
      }),
      usuario([]),
    );

    expect(createdSale.lines[0].unitPrice).toBe(2_500);
    expect(createdSale.lines[0].lineTotal).toBe(30_000);
  });

  it('el total de la línea sale del precio de lista, no del de mostrador', async () => {
    // Si el precio bajara pero el total se calculara con el de catálogo, la
    // tirilla mostraría un descuento que no se cobró y la caja no cuadraría.
    build(
      { _id: new Types.ObjectId(), priceListId: listaMayorista },
      { discountPercent: 10, items: [] },
    );

    await service.create(
      venta({
        customerId: new Types.ObjectId().toString(),
        lines: [{ productId: PROD.toString(), qty: 4 }],
      }),
      usuario([]),
    );

    expect(createdSale.lines[0].unitPrice).toBe(2_700);
    expect(createdSale.lines[0].lineTotal).toBe(10_800);
    expect(createdSale.total).toBe(10_800);
  });
});
