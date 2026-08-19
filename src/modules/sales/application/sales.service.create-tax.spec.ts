import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata de tipo para los @Prop() con uniones de
// literales, y @nestjs/mongoose lanza al no poder inferir el tipo cuando se
// importan los esquemas. Los modelos van mockeados: neutralizamos los
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

import { SalesService } from './sales.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Discriminación de IVA (precio con IVA incluido) y prorrateo del descuento de
 * venta en SalesService.create. Se instancia el servicio con dependencias
 * mockeadas: `catalog` devuelve productos vendibles (salePrice, ivaType,
 * ivaRate); stock/ledger/treasury son vi.fn(). `saleModel.create` DEVUELVE su
 * payload para poder asertar sobre los totales calculados.
 *
 * Se validan INVARIANTES robustas (tolerancia ±1 peso) en vez de números
 * frágiles, porque el módulo redondea a 2 decimales por línea.
 *
 * Constructor (orden):
 *   saleModel, counterModel, stockItemModel, cajaSessionModel, discountModel,
 *   receivableModel, stock, products, sedes, catalog, customers, payroll,
 *   params, ledgerPosting, treasury
 */
describe('SalesService.create (IVA incluido + prorrateo de descuento)', () => {
  const sedeId = new Types.ObjectId();
  const saleId = new Types.ObjectId();

  const DISCOUNT_PERM = 'pos.discount.authorize';

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@erp.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [DISCOUNT_PERM],
  } as unknown as JwtUser;

  // Catálogo de prueba: un gravado 19% y un excluido (sin IVA).
  const PROD_GRAVADO = new Types.ObjectId();
  const PROD_EXCLUIDO = new Types.ObjectId();
  const INV_GRAVADO = new Types.ObjectId();
  const INV_EXCLUIDO = new Types.ObjectId();

  const catalogDb: Record<string, any> = {
    [PROD_GRAVADO.toString()]: {
      _id: PROD_GRAVADO,
      sku: 'G1',
      name: 'Gravado 19',
      unit: 'und',
      salePrice: 11_900, // incluye IVA
      ivaType: 'gravado',
      ivaRate: 19,
      sourceType: 'inventory',
      inventoryProductId: INV_GRAVADO,
      qtyPerUnit: 1,
    },
    [PROD_EXCLUIDO.toString()]: {
      _id: PROD_EXCLUIDO,
      sku: 'E1',
      name: 'Excluido',
      unit: 'und',
      salePrice: 10_000,
      ivaType: 'excluido',
      ivaRate: 0,
      sourceType: 'inventory',
      inventoryProductId: INV_EXCLUIDO,
      qtyPerUnit: 1,
    },
  };

  let saleModel: any;
  let counterModel: any;
  let stockItemModel: any;
  let cajaSessionModel: any;
  let stock: any;
  let catalog: any;
  let sedes: any;
  let ledgerPosting: any;
  let treasury: any;
  let service: SalesService;

  let createdSale: any;

  beforeEach(() => {
    createdSale = undefined;
    saleModel = {
      create: vi.fn().mockImplementation((doc: any) => {
        createdSale = { ...doc, _id: saleId, tip: doc.tip };
        return Promise.resolve(createdSale);
      }),
    };
    counterModel = {
      findOneAndUpdate: vi
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve({ seq: 1 }) }),
    };
    // Hay stock de sobra para cualquier ítem (qty 999).
    stockItemModel = {
      find: vi.fn().mockReturnValue({
        exec: () =>
          Promise.resolve([
            { productId: INV_GRAVADO, qty: 999 },
            { productId: INV_EXCLUIDO, qty: 999 },
          ]),
      }),
    };
    cajaSessionModel = {
      findOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ _id: new Types.ObjectId() }),
      }),
    };
    stock = {
      // sell devuelve una "porción" por componente (para armar components).
      sell: vi.fn().mockImplementation((_sede: string, lines: any[]) =>
        Promise.resolve(
          lines.map((l) => ({
            product: {
              _id: new Types.ObjectId(l.productId),
              sku: 'x',
              name: 'x',
              unit: 'und',
            },
            portions: [
              { lot: { _id: new Types.ObjectId(), unitCost: 100 }, qty: l.qty },
            ],
          })),
        ),
      ),
    };
    catalog = {
      loadSellableOrFail: vi
        .fn()
        .mockImplementation((id: string) => Promise.resolve(catalogDb[id])),
      componentsOf: vi.fn().mockImplementation((product: any, qty: number) => [
        { productId: product.inventoryProductId.toString(), qty: qty },
      ]),
    };
    sedes = { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) };
    ledgerPosting = { postSale: vi.fn().mockResolvedValue(undefined) };
    treasury = { post: vi.fn().mockResolvedValue(undefined) };

    service = new SalesService(
      saleModel,
      counterModel,
      stockItemModel,
      cajaSessionModel,
      {} as any, // discountModel
      {} as any, // receivableModel
      stock,
      {} as any, // products
      sedes,
      catalog,
      {} as any, // customers
      {} as any, // payroll
      {} as any, // params
      ledgerPosting,
      treasury,
    );
  });

  it('IVA incluido: taxableBase + taxTotal ≈ total (±1) y total = subtotal sin descuento', async () => {
    await service.create(
      {
        sedeId: sedeId.toString(),
        lines: [{ productId: PROD_GRAVADO.toString(), qty: 1 }],
        payment: { method: 'cash' },
      } as any,
      user,
    );

    expect(createdSale).toBeDefined();
    // El total NO vuelve a sumar IVA (ya está en el precio).
    expect(createdSale.total).toBe(11_900);
    expect(createdSale.subtotal).toBe(11_900);
    // La base + el IVA reconstruyen el total (con precio IVA incluido).
    expect(
      Math.abs(createdSale.taxableBase + createdSale.taxTotal - createdSale.total),
    ).toBeLessThanOrEqual(1);
    // 11.900 / 1.19 = 10.000 base; IVA = 1.900.
    expect(Math.abs(createdSale.taxableBase - 10_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(createdSale.taxTotal - 1_900)).toBeLessThanOrEqual(1);
  });

  it('producto excluido: no genera IVA (taxTotal = 0, base = total)', async () => {
    await service.create(
      {
        sedeId: sedeId.toString(),
        lines: [{ productId: PROD_EXCLUIDO.toString(), qty: 2 }],
        payment: { method: 'cash' },
      } as any,
      user,
    );

    expect(createdSale.total).toBe(20_000);
    expect(createdSale.taxTotal).toBe(0);
    expect(Math.abs(createdSale.taxableBase - 20_000)).toBeLessThanOrEqual(1);
  });

  it('descuento de venta baja la base gravable y mantiene base + IVA ≈ total', async () => {
    await service.create(
      {
        sedeId: sedeId.toString(),
        lines: [{ productId: PROD_GRAVADO.toString(), qty: 1 }],
        payment: { method: 'cash' },
        discount: { type: 'amount', value: 1_190 }, // 10% del bruto
      } as any,
      user,
    );

    // total = subtotal (11.900) − descuento (1.190) = 10.710.
    expect(createdSale.total).toBe(10_710);
    expect(createdSale.discountTotal).toBe(1_190);
    // La invariante IVA-incluido se mantiene tras el descuento.
    expect(
      Math.abs(createdSale.taxableBase + createdSale.taxTotal - createdSale.total),
    ).toBeLessThanOrEqual(1);
    // Base gravable bajó respecto a los 10.000 sin descuento.
    expect(createdSale.taxableBase).toBeLessThan(10_000);
    // 10.710 / 1.19 = 9.000 base; IVA = 1.710.
    expect(Math.abs(createdSale.taxableBase - 9_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(createdSale.taxTotal - 1_710)).toBeLessThanOrEqual(1);
  });

  it('descuento porcentual se prorratea entre varias líneas (base + IVA ≈ total)', async () => {
    await service.create(
      {
        sedeId: sedeId.toString(),
        lines: [
          { productId: PROD_GRAVADO.toString(), qty: 1 }, // 11.900
          { productId: PROD_EXCLUIDO.toString(), qty: 1 }, // 10.000
        ],
        payment: { method: 'cash' },
        discount: { type: 'percent', value: 10 },
      } as any,
      user,
    );

    // subtotal = 21.900; descuento 10% = 2.190; total = 19.710.
    expect(createdSale.subtotal).toBe(21_900);
    expect(createdSale.discountTotal).toBe(2_190);
    expect(createdSale.total).toBe(19_710);
    expect(
      Math.abs(createdSale.taxableBase + createdSale.taxTotal - createdSale.total),
    ).toBeLessThanOrEqual(1);
  });

  it('propina se cobra ENCIMA del total (no entra a la base ni al IVA)', async () => {
    await service.create(
      {
        sedeId: sedeId.toString(),
        lines: [{ productId: PROD_GRAVADO.toString(), qty: 1 }],
        payment: { method: 'cash', received: 15_000 },
        tip: 2_000,
      } as any,
      user,
    );

    // El total de la venta no incluye la propina.
    expect(createdSale.total).toBe(11_900);
    expect(createdSale.tip).toBe(2_000);
    // El grandTotal cobrado (total + tip = 13.900) es lo que valida el efectivo:
    // received 15.000 > 13.900 no lanza. La propina no cambia base ni IVA.
    expect(
      Math.abs(createdSale.taxableBase + createdSale.taxTotal - createdSale.total),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(createdSale.taxableBase - 10_000)).toBeLessThanOrEqual(1);
  });
});
