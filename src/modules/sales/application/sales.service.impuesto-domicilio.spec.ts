import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// Mismo patrón que el resto de las pruebas de ventas: neutralizar los
// decoradores de @nestjs/mongoose para poder importar los esquemas.
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
 * El domicilio que cobra el restaurante lleva el mismo impuesto que la comida,
 * INCLUIDO en lo cobrado: la base del INC es el «precio total de consumo… y
 * demás valores adicionales» (arts. 512-1 num. 3 y 512-9 ET) y el domicilio es
 * un valor adicional del expendio (Oficio DIAN 664 (904106) de 2022).
 *
 * Y el INC de bolsas plásticas (art. 512-15 ET): un valor fijo por bolsa que
 * se suma aparte del precio de la bolsa, solo si la empresa lo activó.
 */
describe('SalesService.create · impuesto del domicilio y de las bolsas', () => {
  const sedeId = new Types.ObjectId();
  const PLATO = new Types.ObjectId();
  const BOLSA = new Types.ObjectId();
  const INV = new Types.ObjectId();
  const ZONA = new Types.ObjectId();

  const user = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  const catalogDb: Record<string, any> = {
    // Plato de $30.000: en un restaurante lleva INC 8 % incluido.
    [PLATO.toString()]: {
      _id: PLATO,
      sku: 'P1',
      name: 'Bandeja',
      unit: 'und',
      salePrice: 30_000,
      ivaType: 'excluido',
      ivaRate: 0,
      sourceType: 'inventory',
      inventoryProductId: INV,
      qtyPerUnit: 1,
    },
    // La bolsa no se cobra (precio 0): solo causa el INC de bolsas.
    [BOLSA.toString()]: {
      _id: BOLSA,
      sku: 'BOLSA',
      name: 'Bolsa plástica',
      unit: 'und',
      salePrice: 0,
      ivaType: 'gravado',
      ivaRate: 19,
      tratamientoFiscal: 'mercancia',
      bolsaPlastica: true,
      sourceType: 'inventory',
      inventoryProductId: INV,
      qtyPerUnit: 1,
    },
  };

  let creada: any;
  let ledger: any;
  let treasury: any;
  let sedes: any;
  let tax: any;
  let service: SalesService;

  beforeEach(() => {
    creada = undefined;
    ledger = { postSale: vi.fn().mockResolvedValue(undefined) };
    treasury = { post: vi.fn().mockResolvedValue(undefined) };
    sedes = { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) };
    tax = {
      resolveRate: vi.fn().mockResolvedValue({ code: 'INC_8', kind: 'inc', rate: 8 }),
      bagTaxPerUnit: vi.fn().mockResolvedValue(73),
    };
    service = new SalesService(
      {
        create: vi.fn((doc: any) => {
          creada = { ...doc, _id: new Types.ObjectId() };
          return Promise.resolve(creada);
        }),
      } as never,
      { findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({ seq: 1 }) })) } as never,
      { find: vi.fn(() => ({ exec: () => Promise.resolve([{ productId: INV, qty: 999 }]) })) } as never,
      { findOne: vi.fn(() => ({ exec: () => Promise.resolve({ _id: new Types.ObjectId() }) })) } as never,
      {} as never, // discountModel
      {} as never, // receivableModel
      {
        sell: vi.fn((_s: string, lines: any[]) =>
          Promise.resolve(
            lines.map((l) => ({
              product: { _id: INV, sku: 'x', name: 'x', unit: 'und' },
              portions: [{ lot: { _id: new Types.ObjectId(), unitCost: 500 }, qty: l.qty }],
            })),
          ),
        ),
      } as never,
      {} as never, // products
      sedes as never,
      {
        loadSellableOrFail: vi.fn((id: string) => Promise.resolve(catalogDb[id])),
        packagingOf: vi.fn(() => []),
        componentsOf: vi.fn((p: any, qty: number) => [
          { productId: p.inventoryProductId.toString(), qty },
        ]),
      } as never,
      { rulesFor: vi.fn().mockResolvedValue(null) } as never,
      {
        refFor: vi.fn().mockResolvedValue({ id: ZONA.toString(), name: 'Laureles', fee: 5_000 }),
      } as never,
      {} as never, // customers
      {} as never, // payroll
      {} as never, // params
      ledger as never,
      treasury as never,
      {} as never, // sedeModel
      tax as never,
      { findById: vi.fn().mockResolvedValue(null) } as never, // businesses
      {} as never, // saleReturnModel
      {} as never, // cajaMovementModel
    );
  });

  function vender(extra: Record<string, unknown> = {}, tipoNegocio = 'restaurante') {
    return TenantContext.run(
      { businessId: 'b1', dbName: 'biz_b1', tipoNegocio: tipoNegocio as never },
      () =>
        service.create(
          {
            sedeId: sedeId.toString(),
            lines: [{ productId: PLATO.toString(), qty: 1 }],
            payment: { method: 'card' },
            orderType: 'domicilio',
            delivery: { address: 'Calle 33 #70-20', zoneId: ZONA.toString() },
            ...extra,
          } as never,
          user,
        ),
    );
  }

  describe('domicilio', () => {
    it('régimen normal: $5.000 = $4.630 de base + $370 de INC, incluido', async () => {
      await vender();

      expect(creada.deliveryFee).toBe(5_000);
      expect(creada.deliveryTaxKind).toBe('inc');
      expect(creada.deliveryTaxRate).toBe(8);
      expect(creada.deliveryTaxBase).toBe(4_630);
      expect(creada.deliveryTax).toBe(370);
      // La comida no cambia: taxableBase/taxTotal siguen siendo de las líneas.
      expect(creada.total).toBe(30_000);
      expect(creada.taxTotal).toBe(2_222);
    });

    it('el asiento lleva el INC del domicilio y el cobro no cambia de monto', async () => {
      await vender();

      const asiento = ledger.postSale.mock.calls[0][0];
      expect(asiento.deliveryFee).toBe(5_000);
      expect(asiento.deliveryTax).toEqual({ kind: 'inc', amount: 370 });
      expect(asiento.consumptionTax).toBe(2_222);
      // Lo que entra al banco es lo mismo que antes: total + domicilio.
      expect(treasury.post.mock.calls[0][0].amount).toBe(35_000);
    });

    it('franquicia: el domicilio lleva IVA 19 % (art. 447), no INC', async () => {
      sedes.findOrFail.mockResolvedValue({
        _id: sedeId,
        franquicia: true,
        responsableIva: true,
      });
      await vender();

      expect(creada.deliveryTaxKind).toBe('iva');
      expect(creada.deliveryTaxRate).toBe(19);
      // 5.000 / 1,19 = 4.201,68 → 4.202 + 798.
      expect(creada.deliveryTaxBase).toBe(4_202);
      expect(creada.deliveryTax).toBe(798);
      expect(ledger.postSale.mock.calls[0][0].deliveryTax).toEqual({ kind: 'iva', amount: 798 });
    });

    it('no responsable de INC: el domicilio va sin impuesto, entero a ingresos', async () => {
      sedes.findOrFail.mockResolvedValue({ _id: sedeId, responsableInc: false });
      await vender();

      expect(creada.deliveryTaxKind).toBe('ninguno');
      expect(creada.deliveryTax).toBe(0);
      expect(creada.deliveryTaxBase).toBe(5_000);
      expect(ledger.postSale.mock.calls[0][0].deliveryTax).toEqual({
        kind: 'ninguno',
        amount: 0,
      });
    });

    it('fuera de un restaurante (retail) el domicilio sigue sin impuesto', async () => {
      await vender({}, 'retail');
      expect(creada.deliveryTaxKind).toBe('ninguno');
      expect(creada.deliveryTax).toBe(0);
    });

    it('sin domicilio no hay campos de impuesto del domicilio', async () => {
      await vender({ orderType: 'mostrador', delivery: undefined });
      expect(creada.deliveryFee).toBe(0);
      expect(creada.deliveryTaxKind).toBeUndefined();
      expect(ledger.postSale.mock.calls[0][0].deliveryTax).toBeUndefined();
    });
  });

  describe('bolsas plásticas', () => {
    it('2 bolsas: $146 de INC de bolsas aparte, dentro del total y fuera de la base', async () => {
      await vender({
        orderType: 'llevar',
        delivery: undefined,
        lines: [
          { productId: PLATO.toString(), qty: 1 },
          { productId: BOLSA.toString(), qty: 2 },
        ],
      });

      const bolsa = creada.lines[1];
      expect(bolsa.lineTotal).toBe(0);
      expect(bolsa.bagTaxUnit).toBe(73);
      expect(bolsa.bagTax).toBe(146);
      expect(creada.lines[0].bagTax).toBeUndefined();
      expect(creada.bagTaxTotal).toBe(146);
      expect(creada.total).toBe(30_146);
      // El INC de bolsas no es base ni INC ad valorem.
      expect(creada.taxTotal).toBe(2_222);
      expect(creada.taxableBase).toBe(27_778);
      const asiento = ledger.postSale.mock.calls[0][0];
      expect(asiento.bagTax).toBe(146);
      expect(asiento.total).toBe(30_146);
    });

    it('la bolsa que se cobra discrimina su valor y su impuesto por unidad', async () => {
      catalogDb[BOLSA.toString()].salePrice = 200;
      try {
        await vender({ lines: [{ productId: BOLSA.toString(), qty: 3 }] });
      } finally {
        catalogDb[BOLSA.toString()].salePrice = 0;
      }
      const bolsa = creada.lines[0];
      // Valor de la bolsa: 600 con su IVA incluido (mercancía).
      expect(bolsa.lineTotal).toBe(600);
      expect(bolsa.taxKind).toBe('iva');
      expect(bolsa.taxBase + bolsa.taxAmount).toBe(600);
      // INC de bolsas: 3 × 73, aparte.
      expect(bolsa.bagTax).toBe(219);
      expect(creada.total).toBe(819);
    });

    it('con el impuesto sin activar no se cobra nada por la bolsa', async () => {
      tax.bagTaxPerUnit.mockResolvedValue(0);
      await vender({ lines: [{ productId: BOLSA.toString(), qty: 2 }] });
      expect(creada.bagTaxTotal).toBe(0);
      expect(creada.lines[0].bagTax).toBeUndefined();
      expect(creada.total).toBe(0);
    });

    it('restaurante solo responsable de INC: 2 bolsas, $0 de INC de bolsas (art. 512-15)', async () => {
      // El art. 512-15 hace responsables a quienes pertenecen al régimen de
      // responsabilidad del IVA; un restaurante que solo responde por INC no lo cobra.
      sedes.findOrFail.mockResolvedValue({ _id: sedeId, responsableIva: false });
      await vender({
        orderType: 'llevar',
        delivery: undefined,
        lines: [
          { productId: PLATO.toString(), qty: 1 },
          { productId: BOLSA.toString(), qty: 2 },
        ],
      });
      expect(tax.bagTaxPerUnit).not.toHaveBeenCalled();
      expect(creada.bagTaxTotal).toBe(0);
      expect(creada.lines[1].bagTax).toBeUndefined();
      expect(creada.total).toBe(30_000);
    });

    it('venta offline: tarifa del día del cobro y, con lo cobrado, el INC del comprobante', async () => {
      // Cobrada el 31-dic a las 10 p.m. en Bogotá (1-ene en UTC).
      const soldAt = new Date('2027-01-01T03:00:00Z');
      const offline = {
        offlineId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        saleNumber: 'FVC-000001',
        soldAt,
        cajaSessionId: new Types.ObjectId().toString(),
        expectedGrandTotal: 146,
      };
      const dto = {
        sedeId: sedeId.toString(),
        lines: [{ productId: BOLSA.toString(), qty: 2 }],
        payment: { method: 'cash' },
      } as never;
      const enRestaurante = (fn: () => Promise<unknown>) =>
        TenantContext.run(
          { businessId: 'b1', dbName: 'biz_b1', tipoNegocio: 'restaurante' as never },
          fn,
        );

      await enRestaurante(() => service.create(dto, user, undefined, { offline }));
      expect(tax.bagTaxPerUnit).toHaveBeenCalledWith('2026-12-31');
      expect(creada.bagTaxTotal).toBe(146);

      // Con lo cobrado manda el comprobante ($70 por bolsa), no la tarifa de hoy.
      tax.bagTaxPerUnit.mockClear();
      await enRestaurante(() =>
        service.create(dto, user, undefined, {
          offline: {
            ...offline,
            expectedGrandTotal: 140,
            override: { byUserId: 'u-jefe', at: new Date() },
            chargedPrices: { [BOLSA.toString()]: 0 },
            chargedBagTax: { [BOLSA.toString()]: 70 },
          },
        }),
      );
      expect(creada.bagTaxTotal).toBe(140);
      expect(creada.lines[0].bagTaxUnit).toBe(70);
    });

    it('sin bolsas en la venta ni se consulta el impuesto', async () => {
      await vender();
      expect(tax.bagTaxPerUnit).not.toHaveBeenCalled();
      expect(creada.bagTaxTotal).toBe(0);
    });
  });
});
