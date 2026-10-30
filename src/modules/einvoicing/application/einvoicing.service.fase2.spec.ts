import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// Patrón de `orders.service.checkout.spec.ts`: neutraliza los decoradores.
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

import { AVISO_NOTA_SIN_PIN, EinvoicingService } from './einvoicing.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Fase 2 conectada en la emisión: tributo real por línea, domicilio como
 * línea, propina como cargo, CUFE con IVA/INC/ICA y ambiente del emisor, CUDE
 * con PIN en la nota y adquiriente validado antes del folio.
 *
 * El CUFE esperado se arma aquí a mano con la fórmula del anexo FEV 1.9
 * §11.1.2, sin pasar por `cadenaCufe`.
 */
const sha384 = (s: string) => createHash('sha384').update(s, 'utf8').digest('hex');

describe('EinvoicingService · documento de la Fase 2', () => {
  const sedeId = new Types.ObjectId().toString();
  const saleId = new Types.ObjectId();
  const user = { email: 'a@b.co', role: 'owner', permissions: [], sedeIds: [sedeId] } as unknown as JwtUser;
  const CLAVE = 'clave-tecnica';

  let venta: any;
  let emisor: { id: string; tipoAmbiente: string } | null;
  let pin: string | null;
  let factura: any;
  let model: any;
  let counters: any;
  let businesses: any;
  let svc: EinvoicingService;

  const linea = (o: Record<string, unknown>) => ({
    sku: 'P1',
    name: 'Producto',
    qty: 1,
    unit: 'und',
    discountAmount: 0,
    ivaRate: 0,
    ...o,
  });

  const ventaBase = (o: Record<string, unknown> = {}) => ({
    _id: saleId,
    sedeId,
    status: 'completed',
    payment: { method: 'cash' },
    discountTotal: 0,
    tip: 0,
    deliveryFee: 0,
    ...o,
  });

  const emitir = () =>
    TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, () =>
      svc.createFromSale(saleId.toString(), user),
    );

  beforeEach(() => {
    emisor = null;
    pin = null;
    factura = null;
    let seq = 0;
    const cadena = (v: unknown): any => {
      const c: any = { sort: () => c, select: () => c, lean: () => c, exec: () => Promise.resolve(v) };
      return c;
    };
    model = {
      findOne: vi.fn(() => cadena(null)),
      findById: vi.fn(() => cadena(factura)),
      create: vi.fn(async (d: any) => ({ ...d, _id: new Types.ObjectId() })),
    };
    counters = {
      findOneAndUpdate: vi.fn((_f: any, upd: any) => ({
        exec: async () => {
          if (upd.$inc?.seq === 1) seq += 1;
          if (upd.$inc?.seq === -1) seq -= 1;
          return { seq };
        },
      })),
    };
    businesses = {
      consumeDocument: vi.fn(async () => 'monthly'),
      refundDocument: vi.fn(async () => undefined),
    };
    const sedes = {
      findOrFail: vi.fn(async () => ({
        id: sedeId,
        nit: '900.123.456-7',
        nitDv: '7',
        resolucionFe: { prefijo: 'FE', rangoDesde: 1, rangoHasta: 1000, claveTecnica: CLAVE },
        resolucionesFe: [],
      })),
    };
    const sales = { getOrFail: vi.fn(async () => venta) };
    const emisores = {
      obtenerPorSede: vi.fn(async () => emisor),
      leerSecreto: vi.fn(async () => pin),
    };
    svc = new EinvoicingService(model, counters, sales as any, sedes as any, businesses, emisores as any);
  });

  /** Cadena del CUFE según el anexo, con los valores ya formateados. */
  const cufeEsperado = (
    doc: any,
    v: { bruto: string; iva: string; inc: string; tot: string; adq?: string; amb: string },
  ) =>
    sha384(
      doc.fullNumber + doc.issueDate + doc.issueTime + v.bruto +
        '01' + v.iva + '04' + v.inc + '03' + '0.00' + v.tot +
        '900123456' + (v.adq ?? '222222222222') + CLAVE + v.amb,
    );

  it('restaurante: INC por línea, domicilio como línea con INC y propina como cargo en ValTot', async () => {
    venta = ventaBase({
      lines: [
        linea({ name: 'Hamburguesa', unitPrice: 10000, lineTotal: 10000, taxKind: 'inc', taxRate: 8, taxBase: 9259, taxAmount: 741 }),
      ],
      total: 10000,
      deliveryFee: 5000,
      deliveryTaxKind: 'inc',
      deliveryTaxRate: 8,
      deliveryTaxBase: 4630,
      deliveryTax: 370,
      tip: 1500,
    });
    const doc: any = await emitir();

    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0]).toMatchObject({ taxScheme: '04', taxRate: 8, base: 9259, taxAmount: 741, ivaAmount: 0 });
    expect(doc.lines[1]).toMatchObject({
      description: 'Servicio de domicilio',
      taxScheme: '04',
      base: 4630,
      taxAmount: 370,
      total: 5000,
    });
    expect(doc.charges).toEqual([{ chargeIndicator: true, reason: 'Propina voluntaria', amount: 1500 }]);
    expect(doc).toMatchObject({
      taxableBase: 13889,
      ivaTotal: 0,
      incTotal: 1111,
      icaTotal: 0,
      taxInclusiveAmount: 15000,
      chargeTotal: 1500,
      payableAmount: 16500,
      total: 16500,
      tipoAmbiente: '2',
    });
    expect(doc.cufe).toBe(
      cufeEsperado(doc, { bruto: '13889.00', iva: '0.00', inc: '1111.00', tot: '16500.00', amb: '2' }),
    );
    expect(doc.qrUrl).toBe(`https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${doc.cufe}`);
  });

  it('franquicia: IVA 19 % por línea y en el domicilio', async () => {
    venta = ventaBase({
      lines: [linea({ unitPrice: 10000, lineTotal: 10000, taxKind: 'iva', taxRate: 19, ivaRate: 19, taxBase: 8403, taxAmount: 1597 })],
      total: 10000,
      deliveryFee: 5000,
      deliveryTaxKind: 'iva',
      deliveryTaxRate: 19,
      deliveryTaxBase: 4202,
      deliveryTax: 798,
    });
    const doc: any = await emitir();
    expect(doc.lines.map((l: any) => [l.taxScheme, l.ivaRate, l.ivaAmount])).toEqual([
      ['01', 19, 1597],
      ['01', 19, 798],
    ]);
    expect(doc).toMatchObject({ ivaTotal: 2395, incTotal: 0, payableAmount: 15000 });
    expect(doc.cufe).toBe(
      cufeEsperado(doc, { bruto: '12605.00', iva: '2395.00', inc: '0.00', tot: '15000.00', amb: '2' }),
    );
  });

  it('no responsable: líneas sin tributo y los tres pares del CUFE en 0.00', async () => {
    venta = ventaBase({
      lines: [linea({ unitPrice: 10000, lineTotal: 10000, taxKind: 'ninguno', taxRate: 0, taxBase: 10000, taxAmount: 0 })],
      total: 10000,
      deliveryFee: 3000,
      deliveryTaxKind: 'ninguno',
      deliveryTaxRate: 0,
      deliveryTaxBase: 3000,
      deliveryTax: 0,
    });
    const doc: any = await emitir();
    expect(doc.lines.every((l: any) => l.taxScheme === undefined && l.taxAmount === 0)).toBe(true);
    expect(doc).toMatchObject({ taxableBase: 13000, ivaTotal: 0, incTotal: 0, payableAmount: 13000 });
    expect(doc.cufe).toBe(
      cufeEsperado(doc, { bruto: '13000.00', iva: '0.00', inc: '0.00', tot: '13000.00', amb: '2' }),
    );
  });

  it('bolsa: tributo 22 por unidad, fuera de los pares del CUFE pero dentro de ValTot', async () => {
    venta = ventaBase({
      lines: [
        linea({
          name: 'Bolsa plástica',
          qty: 2,
          unitPrice: 100,
          lineTotal: 200,
          taxKind: 'iva',
          taxRate: 19,
          ivaRate: 19,
          taxBase: 168,
          taxAmount: 32,
          bagTaxUnit: 73,
          bagTax: 146,
        }),
      ],
      total: 346,
      bagTaxTotal: 146,
    });
    const doc: any = await emitir();
    expect(doc.lines[0].perUnitTax).toEqual({ codigo: '22', unidades: 2, valorUnitario: 73, valor: 146 });
    expect(doc.lines[0].total).toBe(346);
    expect(doc).toMatchObject({ ivaTotal: 32, bagTaxTotal: 146, taxInclusiveAmount: 346, payableAmount: 346 });
    expect(doc.cufe).toBe(
      cufeEsperado(doc, { bruto: '168.00', iva: '32.00', inc: '0.00', tot: '346.00', amb: '2' }),
    );
  });

  it('venta vieja sin `deliveryTax`: el domicilio va como se registró, sin tributo', async () => {
    venta = ventaBase({
      lines: [linea({ unitPrice: 10000, lineTotal: 10000, taxKind: 'inc', taxRate: 8, taxBase: 9259, taxAmount: 741 })],
      total: 10000,
      deliveryFee: 5000,
    });
    const doc: any = await emitir();
    expect(doc.lines[1]).toMatchObject({ taxScheme: undefined, base: 5000, taxAmount: 0 });
    expect(doc).toMatchObject({ taxableBase: 14259, incTotal: 741, payableAmount: 15000 });
  });

  it('ambiente del emisor: 1 y 2 dan CUFE y catálogo del QR distintos', async () => {
    venta = ventaBase({
      lines: [linea({ unitPrice: 10000, lineTotal: 10000, taxKind: 'inc', taxRate: 8, taxBase: 9259, taxAmount: 741 })],
      total: 10000,
    });
    emisor = { id: 'e1', tipoAmbiente: '1' };
    const prod: any = await emitir();
    expect(prod.tipoAmbiente).toBe('1');
    expect(prod.cufe).toBe(
      cufeEsperado(prod, { bruto: '9259.00', iva: '0.00', inc: '741.00', tot: '10000.00', amb: '1' }),
    );
    expect(prod.qrUrl).toBe(`https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${prod.cufe}`);

    emisor = { id: 'e1', tipoAmbiente: '2' };
    const hab: any = await emitir();
    expect(hab.tipoAmbiente).toBe('2');
    expect(hab.cufe).toBe(
      cufeEsperado(hab, { bruto: '9259.00', iva: '0.00', inc: '741.00', tot: '10000.00', amb: '2' }),
    );
    expect(hab.qrUrl).toContain('catalogo-vpfe-hab.dian.gov.co');
  });

  it('adquiriente con NIT: entra al CUFE sin DV', async () => {
    venta = ventaBase({
      lines: [linea({ unitPrice: 10000, lineTotal: 10000, taxKind: 'inc', taxRate: 8, taxBase: 9259, taxAmount: 741 })],
      total: 10000,
      customer: {
        name: 'Cliente SAS',
        idNumber: '800199436-4',
        docType: '31',
        nitDv: '4',
        tipoPersona: '1',
        responsabilidades: ['O-13'],
        municipioDane: '11001',
        address: 'Calle 1',
        emailFacturacion: 'f@c.co',
      },
    });
    const doc: any = await emitir();
    expect(doc.cufe).toBe(
      cufeEsperado(doc, { bruto: '9259.00', iva: '0.00', inc: '741.00', tot: '10000.00', adq: '800199436', amb: '2' }),
    );
  });

  it('FEV con adquiriente incompleto: rechaza con lo que falta y no gasta cupo ni folio', async () => {
    venta = ventaBase({
      lines: [linea({ unitPrice: 10000, lineTotal: 10000, taxKind: 'inc', taxRate: 8, taxBase: 9259, taxAmount: 741 })],
      total: 10000,
      customer: { name: 'Pedro', idNumber: '1020304050', docType: '13' },
    });
    const err = await emitir().catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/tipo de persona/);
    expect(err.message).toMatch(/municipio/);
    expect(businesses.consumeDocument).not.toHaveBeenCalled();
    expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });

  describe('nota crédito', () => {
    const facturaGuardada = () => ({
      _id: new Types.ObjectId(),
      type: 'invoice',
      saleId,
      sedeId: new Types.ObjectId(sedeId),
      fullNumber: 'FE1',
      cufe: 'cufe-factura',
      emisor: { nit: '900.123.456-7', nitNorm: '900123456' },
      adquiriente: { docType: '13', docNumber: '222222222222' },
      lines: [],
      taxableBase: 13889,
      ivaTotal: 0,
      incTotal: 1111,
      icaTotal: 0,
      payableAmount: 16500,
      total: 16500,
      discountTotal: 0,
      formaPago: '1',
      medioPago: '10',
    });
    const anular = () =>
      TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, () =>
        svc.createCreditNote(factura._id.toString(), 'Anulación', user),
      );

    it('con PIN: CUDE con el PIN del software y el ambiente del emisor', async () => {
      factura = facturaGuardada();
      emisor = { id: 'e1', tipoAmbiente: '1' };
      pin = '12345';
      const nota: any = await anular();
      const esperado = sha384(
        nota.fullNumber + nota.issueDate + nota.issueTime + '13889.00' +
          '01' + '0.00' + '04' + '1111.00' + '03' + '0.00' + '16500.00' +
          '900123456' + '222222222222' + '12345' + '1',
      );
      expect(nota.cufe).toBe(esperado);
      expect(nota.qrUrl).toBe(`https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${esperado}`);
      expect(nota.aviso).toBeUndefined();
      expect(nota.dianStatus).toBe('draft');
    });

    it('sin PIN: queda en borrador sin CUDE y con el aviso, nunca con la clave técnica', async () => {
      factura = facturaGuardada();
      emisor = { id: 'e1', tipoAmbiente: '2' };
      pin = null;
      const nota: any = await anular();
      expect(nota.cufe).toBeUndefined();
      expect(nota.qrUrl).toBeUndefined();
      expect(nota.aviso).toBe(AVISO_NOTA_SIN_PIN);
      expect(nota.dianStatus).toBe('draft');
    });

    it('sin emisor fiscal: tampoco hay CUDE', async () => {
      factura = facturaGuardada();
      const nota: any = await anular();
      expect(nota.cufe).toBeUndefined();
      expect(nota.aviso).toBe(AVISO_NOTA_SIN_PIN);
      expect(nota.tipoAmbiente).toBe('2');
    });
  });
});
