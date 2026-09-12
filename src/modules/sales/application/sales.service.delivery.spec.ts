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
 * El cobro del domicilio dentro de la venta.
 *
 * La regla que lo define, decidida con el dueño: el domicilio **no lleva IVA** y
 * se cobra **encima del total**, igual que la propina. Meterlo en la base
 * gravable saldría mal en la factura electrónica ante la DIAN, y eso no se
 * arregla solo.
 *
 * Pero a diferencia de la propina, el domicilio **sí es ingreso del negocio**:
 * la propina es del personal. Por eso uno va al libro contable y la otra no.
 *
 * Y lo tercero: la tarifa la pone el SERVIDOR a partir de la zona. Si viajara
 * desde el navegador, cualquiera podría cobrarse el envío a cero.
 *
 * Constructor (orden):
 *   saleModel, counterModel, stockItemModel, cajaSessionModel, discountModel,
 *   receivableModel, stock, products, sedes, catalog, priceLists, deliveryZones,
 *   customers,
 *   payroll, params, ledgerPosting, treasury
 */
describe('SalesService.create · domicilio', () => {
  const sedeId = new Types.ObjectId();
  const PROD = new Types.ObjectId();
  const INV = new Types.ObjectId();
  const ZONA = new Types.ObjectId();

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
  let service: SalesService;

  /** @param zona lo que devuelve `deliveryZones.refFor` */
  function build(zona: unknown = null) {
    creada = undefined;
    ledger = { postSale: vi.fn().mockResolvedValue(undefined) };
    treasury = { post: vi.fn().mockResolvedValue(undefined) };

    service = new SalesService(
      {
        create: vi.fn((doc: any) => {
          creada = { ...doc, _id: new Types.ObjectId() };
          return Promise.resolve(creada);
        }),
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
      {} as never, // receivableModel
      {
        sell: vi.fn((_s: string, lines: any[]) =>
          Promise.resolve(
            lines.map((l) => ({
              product: { _id: INV, sku: 'x', name: 'x', unit: 'und' },
              portions: [
                { lot: { _id: new Types.ObjectId(), unitCost: 500 }, qty: l.qty },
              ],
            })),
          ),
        ),
      } as never,
      {} as never, // products
      { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) } as never,
      {
        loadSellableOrFail: vi.fn((id: string) => Promise.resolve(catalogDb[id])),
        componentsOf: vi.fn((p: any, qty: number) => [
          { productId: p.inventoryProductId.toString(), qty },
        ]),
      } as never,
      // Sin lista de precios: se cobra el precio de mostrador del catálogo.
      { rulesFor: vi.fn().mockResolvedValue(null) } as never,
      { refFor: vi.fn().mockResolvedValue(zona) } as never,
      {} as never, // customers
      {} as never, // payroll
      {} as never, // params
      ledger as never,
      treasury as never,
    );
  }

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

  it('la tarifa sale de la ZONA, no de lo que mande el navegador', async () => {
    // Si viajara desde el navegador, cualquiera podría cobrarse el envío a cero.
    build({ id: ZONA.toString(), name: 'Laureles', fee: 5_000 });

    await service.create(
      venta({
        orderType: 'domicilio',
        delivery: {
          address: 'Calle 33 #70-20',
          zoneId: ZONA.toString(),
          fee: 500, // intento de pagar menos
        },
      }),
      user,
    );

    expect(creada.deliveryFee).toBe(5_000);
    expect(creada.delivery.zoneName).toBe('Laureles');
    expect(creada.orderType).toBe('domicilio');
  });

  it('el domicilio NO entra a la base gravable ni al IVA', async () => {
    // Es la regla que se acordó con el dueño. Meterlo dentro saldría mal en la
    // factura electrónica.
    build({ id: ZONA.toString(), name: 'Laureles', fee: 5_000 });

    await service.create(
      venta({
        orderType: 'domicilio',
        delivery: { address: 'Calle 33', zoneId: ZONA.toString() },
      }),
      user,
    );

    // La arepa: 11.900 con IVA = 10.000 de base + 1.900 de IVA.
    expect(Math.round(creada.taxableBase)).toBe(10_000);
    expect(Math.round(creada.taxTotal)).toBe(1_900);
    expect(Math.round(creada.total)).toBe(11_900);
    // Y el domicilio va aparte.
    expect(creada.deliveryFee).toBe(5_000);
  });

  it('sí es ingreso del negocio: va al libro, a diferencia de la propina', async () => {
    build({ id: ZONA.toString(), name: 'Laureles', fee: 5_000 });

    await service.create(
      venta({
        orderType: 'domicilio',
        tip: 2_000,
        delivery: { address: 'Calle 33', zoneId: ZONA.toString() },
      }),
      user,
    );

    const asiento = ledger.postSale.mock.calls[0][0];
    expect(asiento.deliveryFee).toBe(5_000);
    // La propina no aparece: esa es del personal.
    expect(asiento.total).toBe(11_900);
  });

  it('lo cobrado de más se le exige al cliente: total + propina + domicilio', async () => {
    build({ id: ZONA.toString(), name: 'Laureles', fee: 5_000 });

    // 11.900 + 2.000 de propina + 5.000 de domicilio = 18.900. Con 18.000 no
    // alcanza y la venta no se puede registrar.
    await expect(
      service.create(
        venta({
          orderType: 'domicilio',
          tip: 2_000,
          payment: { method: 'cash', received: 18_000 },
          delivery: { address: 'Calle 33', zoneId: ZONA.toString() },
        }),
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sin zona vale el valor escrito a mano', async () => {
    build(null);

    await service.create(
      venta({
        orderType: 'domicilio',
        delivery: { address: 'Vereda El Salado', fee: 15_000 },
      }),
      user,
    );

    expect(creada.deliveryFee).toBe(15_000);
    expect(creada.delivery.zoneId).toBeUndefined();
  });

  it('un domicilio sin dirección es 400', async () => {
    build(null);
    await expect(
      service.create(
        venta({ orderType: 'domicilio', delivery: { fee: 5_000 } }),
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('mandar dirección sin marcar domicilio es 400, no un cobro silencioso', async () => {
    // Casi siempre es que se escogió mal el tipo de pedido. Cobrar el envío
    // igual sería un cobro que nadie pidió; ignorarlo, un domicilio que nadie
    // va a entregar.
    build(null);
    await expect(
      service.create(
        venta({
          orderType: 'mostrador',
          delivery: { address: 'Calle 33', fee: 5_000 },
        }),
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una venta normal sigue sin domicilio y sin tipo raro', async () => {
    build(null);
    await service.create(venta(), user);
    expect(creada.orderType).toBe('mostrador');
    expect(creada.deliveryFee).toBe(0);
    expect(creada.delivery).toBeUndefined();
  });
});
