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
import { TenantContext } from '../../../shared/tenancy/tenant-context';
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
  let tax: any;
  let businesses: any;
  let service: SalesService;

  let createdSale: any;
  const DESC_ID = new Types.ObjectId();
  let discountModelRef: any;

  beforeEach(() => {
    createdSale = undefined;
    discountModelRef = {
      find: vi.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
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
      // Ningún producto de esta prueba gasta empaque.
      packagingOf: vi.fn(() => []),
      componentsOf: vi.fn().mockImplementation((product: any, qty: number) => [
        { productId: product.inventoryProductId.toString(), qty: qty },
      ]),
    };
    sedes = { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) };
    ledgerPosting = { postSale: vi.fn().mockResolvedValue(undefined) };
    treasury = { post: vi.fn().mockResolvedValue(undefined) };
    // Catálogo de impuestos: la tarifa vigente del INC.
    // Control-plane: de aquí sale el giro si el token no lo trae.
    businesses = { findById: vi.fn().mockResolvedValue(null) };
    tax = {
      resolveRate: vi.fn().mockResolvedValue({ code: 'INC_8', kind: 'inc', rate: 8 }),
    };

    service = new SalesService(
      saleModel,
      counterModel,
      stockItemModel,
      cajaSessionModel,
      discountModelRef,
      {} as any, // receivableModel
      stock,
      {} as any, // products
      sedes,
      catalog,
      // Sin lista de precios: se cobra el precio de mostrador del catálogo.
      { rulesFor: async () => null } as any, // priceLists
      // Sin domicilio: no hay zona que resolver.
      { refFor: async () => null } as any, // deliveryZones
      {} as any, // customers
      {} as any, // payroll
      {} as any, // params
      ledgerPosting,
      treasury,
      {} as any, // sedeModel: solo lo recibe populate, que aquí está simulado
      tax,
      businesses,
      {} as any, // saleReturnModel: solo lo usa la anulación
      {} as any, // cajaMovementModel: solo lo usa la anulación
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

  /**
   * Ítem 1.3: el régimen del negocio decide el impuesto. Un restaurante no
   * cobra IVA sobre lo que sirve sino INC 8 % (arts. 426, 512-1 y 512-9 ET), y
   * va a la 2495, no a la 2408. Un no responsable de IVA no lo cobra (art. 437).
   */
  describe('régimen fiscal del negocio', () => {
    const PLATO = new Types.ObjectId();
    const INV_PLATO = new Types.ObjectId();

    beforeEach(() => {
      // Un plato de $30.000 que el catálogo trae como "gravado 19 %", que es
      // con lo que nacen todos los productos hoy.
      catalogDb[PLATO.toString()] = {
        _id: PLATO,
        sku: 'P1',
        name: 'Bandeja',
        unit: 'und',
        salePrice: 30_000,
        ivaType: 'gravado',
        ivaRate: 19,
        sourceType: 'inventory',
        inventoryProductId: INV_PLATO,
        qtyPerUnit: 1,
      };
      stockItemModel.find.mockReturnValue({
        exec: () => Promise.resolve([{ productId: INV_PLATO, qty: 999 }]),
      });
    });

    function vender(tipoNegocio: 'restaurante' | 'retail') {
      return TenantContext.run(
        { businessId: 'b1', dbName: 'biz_b1', tipoNegocio },
        () =>
          service.create(
            {
              sedeId: sedeId.toString(),
              lines: [{ productId: PLATO.toString(), qty: 1 }],
              payment: { method: 'cash' },
            } as any,
            user,
          ),
      );
    }

    it('restaurante: un plato de $30.000 lleva INC de $2.222, no IVA de $4.790', async () => {
      sedes.findOrFail.mockResolvedValue({
        _id: sedeId,
        responsabilidadFiscal: 'responsable_iva',
      });

      await vender('restaurante');

      expect(createdSale.total).toBe(30_000);
      expect(Math.round(createdSale.taxTotal)).toBe(2_222);
      expect(Math.round(createdSale.taxableBase)).toBe(27_778);
      const linea = createdSale.lines[0];
      expect(linea.taxKind).toBe('inc');
      expect(linea.taxRate).toBe(8);
      // No es IVA: la tarifa de IVA de la línea queda en cero.
      expect(linea.ivaRate).toBe(0);
      // La tarifa sale del catálogo de impuestos, no de un 8 escrito a mano.
      expect(tax.resolveRate).toHaveBeenCalledWith('INC_8');
    });

    it('restaurante: el asiento manda el INC a la 2495 (consumptionTax) y nada al IVA', async () => {
      sedes.findOrFail.mockResolvedValue({
        _id: sedeId,
        responsabilidadFiscal: 'regimen_simple',
      });

      await vender('restaurante');

      const asiento = ledgerPosting.postSale.mock.calls[0][0];
      expect(asiento.tax).toBe(0);
      expect(asiento.consumptionTax).toBe(2_222);
    });

    it('retail responsable de IVA: sigue con el IVA del producto', async () => {
      sedes.findOrFail.mockResolvedValue({
        _id: sedeId,
        responsabilidadFiscal: 'responsable_iva',
      });

      await vender('retail');

      expect(createdSale.lines[0].taxKind).toBe('iva');
      expect(createdSale.lines[0].ivaRate).toBe(19);
      const asiento = ledgerPosting.postSale.mock.calls[0][0];
      expect(asiento.tax).toBe(4_790);
      expect(asiento.consumptionTax).toBe(0);
    });

    it('retail no responsable de IVA: no discrimina impuesto alguno', async () => {
      sedes.findOrFail.mockResolvedValue({
        _id: sedeId,
        responsabilidadFiscal: 'no_responsable_iva',
      });

      await vender('retail');

      expect(createdSale.taxTotal).toBe(0);
      expect(createdSale.taxableBase).toBe(30_000);
      expect(createdSale.lines[0].taxKind).toBe('ninguno');
      const asiento = ledgerPosting.postSale.mock.calls[0][0];
      expect(asiento.tax).toBe(0);
      expect(asiento.consumptionTax).toBe(0);
    });

    /**
     * El giro viaja en el claim `biztype` del token, pero los tokens anteriores
     * a ese claim no lo traen. Sin giro, un restaurante cobraba IVA 19 % en vez
     * de INC 8 %. Se lee de la empresa, una sola vez por venta.
     */
    it('token sin giro: lo lee de la empresa (una vez por venta) y causa INC', async () => {
      sedes.findOrFail.mockResolvedValue({
        _id: sedeId,
        responsabilidadFiscal: 'responsable_iva',
      });
      businesses.findById.mockResolvedValue({ tipoNegocio: 'restaurante' });

      await TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, () =>
        service.create(
          {
            sedeId: sedeId.toString(),
            lines: [
              { productId: PLATO.toString(), qty: 1 },
              { productId: PLATO.toString(), qty: 2 },
            ],
            payment: { method: 'cash' },
          } as any,
          user,
        ),
      );

      expect(businesses.findById).toHaveBeenCalledTimes(1);
      expect(businesses.findById).toHaveBeenCalledWith('b1');
      expect(createdSale.lines.every((l: any) => l.taxKind === 'inc')).toBe(true);
      const asiento = ledgerPosting.postSale.mock.calls[0][0];
      expect(asiento.tax).toBe(0);
    });

    it('token con giro: no consulta la empresa', async () => {
      sedes.findOrFail.mockResolvedValue({
        _id: sedeId,
        responsabilidadFiscal: 'responsable_iva',
      });

      await vender('restaurante');

      expect(businesses.findById).not.toHaveBeenCalled();
    });

    /**
     * Doble redondeo: el IVA salía de `Math.round(taxTotal) - incTax`, con
     * `taxTotal` redondeado a centavos y el INC a peso por otro camino. Con
     * INC de 4.071,70 + 310,27 + 1.796,53 (= 6.178,4999… en coma flotante) el
     * total redondeaba a 6.179 y el INC a 6.178: un peso de INC caía en el IVA.
     */
    it('INC de varias líneas: todo va al INC y el IVA queda en 0 (sin doble redondeo)', async () => {
      sedes.findOrFail.mockResolvedValue({
        _id: sedeId,
        responsabilidadFiscal: 'responsable_iva',
      });
      // Precios (INC 8 % incluido) y cantidades (venta por peso) cuyo INC por
      // línea es 4.071,70 / 310,27 / 1.796,53.
      const precios = [54_968, 41_886, 242_531];
      const cantidades = [1, 0.1, 0.1];
      const ids = precios.map((salePrice, i) => {
        const id = new Types.ObjectId();
        catalogDb[id.toString()] = {
          ...catalogDb[PLATO.toString()],
          _id: id,
          sku: `P${i + 2}`,
          salePrice,
        };
        return id;
      });

      await TenantContext.run(
        { businessId: 'b1', dbName: 'biz_b1', tipoNegocio: 'restaurante' },
        () =>
          service.create(
            {
              sedeId: sedeId.toString(),
              lines: ids.map((id, i) => ({
                productId: id.toString(),
                qty: cantidades[i],
              })),
              payment: { method: 'cash' },
            } as any,
            user,
          ),
      );

      // Ítem 1.11: cada línea en pesos enteros (4.072 / 310 / 1.797), sin
      // los centavos que antes quedaban guardados.
      expect(createdSale.lines.map((l: any) => l.taxAmount)).toEqual([
        4_072, 310, 1_797,
      ]);
      const asiento = ledgerPosting.postSale.mock.calls[0][0];
      expect(asiento.tax).toBe(0);
      expect(asiento.consumptionTax).toBe(6_179);
      expect(createdSale.taxableBase + createdSale.taxTotal).toBe(
        createdSale.total,
      );
    });
  });

  /**
   * Ítem 1.11: en la venta no circulan fracciones de peso. Descuentos, base,
   * impuesto y propina en COP entero, y las partes cuadran EXACTO con el total
   * (sin la tolerancia de ±1 de las pruebas de arriba).
   */
  describe('sin fracciones de peso (1.11)', () => {
    const P9999 = new Types.ObjectId();
    const P10001 = new Types.ObjectId();
    const INV = new Types.ObjectId();

    beforeEach(() => {
      catalogDb[P9999.toString()] = {
        ...catalogDb[PROD_GRAVADO.toString()],
        _id: P9999,
        sku: 'G9',
        salePrice: 9_999,
        inventoryProductId: INV,
      };
      catalogDb[P10001.toString()] = {
        ...catalogDb[PROD_EXCLUIDO.toString()],
        _id: P10001,
        sku: 'E10',
        salePrice: 10_001,
        inventoryProductId: INV,
      };
      stockItemModel.find.mockReturnValue({
        exec: () =>
          Promise.resolve([
            { productId: INV, qty: 999 },
            { productId: INV_GRAVADO, qty: 999 },
            { productId: INV_EXCLUIDO, qty: 999 },
          ]),
      });
    });

    const enteros = (xs: number[]) => xs.every(Number.isInteger);

    it('descuento de venta que no divide exacto entre tres líneas: suma exacta, residuo al final', async () => {
      await service.create(
        {
          sedeId: sedeId.toString(),
          lines: [
            { productId: PROD_GRAVADO.toString(), qty: 1 },
            { productId: PROD_GRAVADO.toString(), qty: 1 },
            { productId: PROD_GRAVADO.toString(), qty: 1 },
          ],
          payment: { method: 'cash' },
          discount: { type: 'amount', value: 1_000 },
        } as any,
        user,
      );

      const lines = createdSale.lines;
      expect(createdSale.discountTotal).toBe(1_000);
      expect(createdSale.total).toBe(35_700 - 1_000);
      expect(enteros(lines.map((l: any) => l.taxBase))).toBe(true);
      expect(enteros(lines.map((l: any) => l.taxAmount))).toBe(true);
      // La suma de lo que paga cada línea es exacto el total de la venta.
      const pagado = lines.reduce(
        (s: number, l: any) => s + l.taxBase + l.taxAmount,
        0,
      );
      expect(pagado).toBe(createdSale.total);
      expect(createdSale.taxableBase + createdSale.taxTotal).toBe(
        createdSale.total,
      );
    });

    it('descuento por línea porcentual que deja fracción: se guarda en pesos', async () => {
      discountModelRef.find.mockReturnValue({
        exec: () =>
          Promise.resolve([
            { id: DESC_ID.toString(), type: 'percent', value: 7, name: '7 %' },
          ]),
      });
      await service.create(
        {
          sedeId: sedeId.toString(),
          lines: [
            { productId: P9999.toString(), qty: 1, discountId: DESC_ID.toString() },
          ],
          payment: { method: 'cash' },
        } as any,
        user,
      );
      // 7 % de 9.999 = 699,93 → 700.
      expect(createdSale.lines[0].discountAmount).toBe(700);
      expect(createdSale.total).toBe(9_299);
      expect(createdSale.taxableBase + createdSale.taxTotal).toBe(9_299);
    });

    it('IVA 19 % sobre un precio que deja fracción: base e IVA en pesos que suman el total', async () => {
      await service.create(
        {
          sedeId: sedeId.toString(),
          lines: [
            { productId: P9999.toString(), qty: 1 },
            { productId: P9999.toString(), qty: 2 },
          ],
          payment: { method: 'cash' },
        } as any,
        user,
      );
      expect(createdSale.total).toBe(29_997);
      expect(createdSale.lines.map((l: any) => [l.taxBase, l.taxAmount])).toEqual([
        [8_403, 1_596],
        [16_805, 3_193],
      ]);
      expect(createdSale.taxableBase).toBe(25_208);
      expect(createdSale.taxTotal).toBe(4_789);
      expect(ledgerPosting.postSale.mock.calls[0][0].tax).toBe(4_789);
    });

    it('propina con centavos se cobra en pesos enteros', async () => {
      await service.create(
        {
          sedeId: sedeId.toString(),
          lines: [{ productId: PROD_GRAVADO.toString(), qty: 1 }],
          payment: { method: 'cash', received: 20_000 },
          tip: 1_190.6,
        } as any,
        user,
      );
      expect(createdSale.tip).toBe(1_191);
      expect(createdSale.payment.change).toBe(20_000 - 11_900 - 1_191);
    });

    it('efectivo recibido con centavos: recibido y cambio en pesos enteros', async () => {
      await service.create(
        {
          sedeId: sedeId.toString(),
          lines: [{ productId: PROD_GRAVADO.toString(), qty: 1 }],
          payment: { method: 'cash', received: 15_000.4 },
        } as any,
        user,
      );
      expect(createdSale.payment.received).toBe(15_000);
      expect(createdSale.payment.change).toBe(3_100);
    });

    it('cuenta dividida en 3: las tres ventas suman exacto el valor de la línea', async () => {
      const partes = [0.333, 0.333, 0.334];
      const totales: number[] = [];
      let pagado = 0;
      for (const qty of partes) {
        await service.create(
          {
            sedeId: sedeId.toString(),
            lines: [{ productId: P10001.toString(), qty }],
            payment: { method: 'cash' },
          } as any,
          user,
          undefined,
          { paidBefore: new Map([[P10001.toString(), pagado]]) },
        );
        pagado += qty;
        totales.push(createdSale.total);
        expect(createdSale.taxableBase + createdSale.taxTotal).toBe(
          createdSale.total,
        );
      }
      expect(enteros(totales)).toBe(true);
      expect(totales.reduce((s, t) => s + t, 0)).toBe(10_001);
    });
  });

  it('el asiento y la tesorería llevan la fecha de Colombia, no la del servidor', async () => {
    // 14-oct 02:00 UTC es todavía 13-oct en Bogotá. En Vercel (UTC) la venta
    // de las 9 p. m. caía al día siguiente: al mes siguiente si era el 31.
    const tzAntes = process.env.TZ;
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T02:00:00Z'));
    try {
      await service.create(
        {
          sedeId: sedeId.toString(),
          lines: [{ productId: PROD_GRAVADO.toString(), qty: 1 }],
          payment: { method: 'card' },
        } as any,
        user,
      );
    } finally {
      vi.useRealTimers();
      process.env.TZ = tzAntes;
    }

    expect(ledgerPosting.postSale.mock.calls[0]![0].date).toBe('2026-10-13');
    expect(treasury.post.mock.calls[0]![0].date).toBe('2026-10-13');
  });

  it('el fiado a un empleado se fecha con el día de Colombia', async () => {
    const payroll = { createDeduction: vi.fn().mockResolvedValue(undefined) };
    const conFiado = new SalesService(
      saleModel,
      counterModel,
      stockItemModel,
      cajaSessionModel,
      discountModelRef,
      {} as any,
      stock,
      {} as any,
      sedes,
      catalog,
      { rulesFor: async () => null } as any,
      { refFor: async () => null } as any,
      {} as any,
      payroll as any,
      {} as any,
      ledgerPosting,
      treasury,
      {} as any,
      tax,
      businesses,
      {} as any,
      {} as any, // cajaMovementModel
    );
    const tzAntes = process.env.TZ;
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T02:00:00Z'));
    try {
      await conFiado.create(
        {
          sedeId: sedeId.toString(),
          lines: [{ productId: PROD_GRAVADO.toString(), qty: 1 }],
          payment: {
            method: 'credit',
            debtorType: 'employee',
            employeeId: new Types.ObjectId().toString(),
          },
        } as any,
        user,
      );
    } finally {
      vi.useRealTimers();
      process.env.TZ = tzAntes;
    }

    expect(payroll.createDeduction.mock.calls[0]![0].date).toBe('2026-10-13');
  });
});
