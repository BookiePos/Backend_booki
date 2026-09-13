import { describe, it, expect, vi, beforeEach } from 'vitest';
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
 * Vendedor: quién atendió, que no siempre es quien cobra.
 *
 * En el mostrador de una galletería uno atiende al cliente y otro pasa la venta
 * por la caja. Si la venta solo guarda al cajero, no hay forma de saber cuánto
 * vendió cada uno.
 *
 * Constructor (orden):
 *   saleModel, counterModel, stockItemModel, cajaSessionModel, discountModel,
 *   receivableModel, stock, products, sedes, catalog, priceLists, deliveryZones,
 *   customers, payroll, params, ledgerPosting, treasury
 */
describe('SalesService.create · vendedor', () => {
  const sedeId = new Types.ObjectId();
  const GALLETA = new Types.ObjectId();
  const INV_GALLETA = new Types.ObjectId();
  const EMPLEADA = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let guardada: Record<string, any>;
  let service: SalesService;

  beforeEach(() => {
    vi.clearAllMocks();
    guardada = {};
    service = new SalesService(
      {
        create: vi.fn((doc: any) => {
          guardada = doc;
          return Promise.resolve({ ...doc, _id: new Types.ObjectId() });
        }),
      } as never,
      {
        findOneAndUpdate: vi.fn(() => ({
          exec: () => Promise.resolve({ seq: 1 }),
        })),
      } as never,
      {
        find: vi.fn(() => ({
          exec: () =>
            Promise.resolve([
              { productId: INV_GALLETA, qty: 100 },
            ]),
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
              product: { _id: new Types.ObjectId(l.productId), sku: 'x', name: 'x', unit: 'und' },
              portions: [
                { lot: { _id: new Types.ObjectId(), unitCost: 100 }, qty: l.qty },
              ],
            })),
          ),
        ),
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
        packagingOf: vi.fn(() => []),
      } as never,
      { rulesFor: vi.fn().mockResolvedValue(null) } as never,
      { refFor: vi.fn().mockResolvedValue(null) } as never,
      {} as never, // customers
      {} as never, // payroll
      {} as never, // params
      { postSale: vi.fn().mockResolvedValue(undefined) } as never,
      { post: vi.fn().mockResolvedValue(undefined) } as never,
    );
  });

  function venta(extra: Record<string, unknown> = {}) {
    return {
      sedeId: sedeId.toString(),
      lines: [{ productId: GALLETA.toString(), qty: 1 }],
      payment: { method: 'cash', received: 10_000 },
      ...extra,
    } as never;
  }

  it('guarda quién vendió, aparte de quién cobró', async () => {
    await service.create(
      venta({ seller: { employeeId: EMPLEADA.toString(), name: ' Laura ' } }),
      user,
    );

    expect(guardada.cashierName).toBe('Cajero');
    expect(guardada.seller.name).toBe('Laura');
    expect(guardada.seller.employeeId.toString()).toBe(EMPLEADA.toString());
  });

  it('sin vendedor, la venta queda como antes: a nombre de quien cobra', async () => {
    await service.create(venta(), user);
    expect(guardada.seller).toBeUndefined();
    expect(guardada.cashierName).toBe('Cajero');
  });

  it('un vendedor sin nombre se descarta en vez de guardar un hueco', async () => {
    await service.create(venta({ seller: { name: '   ' } }), user);
    expect(guardada.seller).toBeUndefined();
  });

  it('el vendedor puede no ser empleado de nómina: basta el nombre', async () => {
    await service.create(venta({ seller: { name: 'Sobrino de Paulo' } }), user);
    expect(guardada.seller).toEqual({ name: 'Sobrino de Paulo', employeeId: undefined });
  });

  it('calcula la devuelta exacta con lo que entrega el cliente', async () => {
    // Lo que pidió el dueño: cobra 3.000, le dan 10.000, el sistema dice 7.000.
    await service.create(venta(), user);
    expect(guardada.payment).toEqual({ method: 'cash', received: 10_000, change: 7_000 });
  });
});
