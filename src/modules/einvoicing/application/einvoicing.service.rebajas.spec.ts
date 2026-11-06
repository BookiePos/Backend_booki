import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
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

import { EinvoicingService } from './einvoicing.service';
import { documentoDeVenta } from '../domain/documento-venta';
import { prepararNotaUbl } from '../domain/ubl/nota-de-documento';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Emisión de la nota de una devolución o anulación (Fase 6B): FEV → 91 con
 * CUFE referido, POS → 94 con CUDE referido, `referenceType` siempre desde el
 * documento, tope contra las notas previas, idempotencia por operación y
 * fallar cerrado antes de cupo y folio.
 */

describe('EinvoicingService · rebajas y notas sin referencia (Fase 6C)', () => {
  const sedeId = new Types.ObjectId().toString();
  const saleId = new Types.ObjectId();
  const HAMB = new Types.ObjectId();
  const GAS = new Types.ObjectId();
  const user = { email: 'a@b.co', role: 'owner', permissions: ['pos.void.authorize'], sedeIds: [sedeId] } as unknown as JwtUser;

  const ventaDoc = {
    lines: [
      { sku: 'H1', name: 'Hamburguesa', qty: 3, unitPrice: 10_000, lineTotal: 30_000, taxKind: 'inc' as const, taxRate: 8, taxBase: 27_778, taxAmount: 2_222 },
      { sku: 'G1', name: 'Gaseosa', qty: 2, unitPrice: 5_000, lineTotal: 10_000, taxKind: 'iva' as const, taxRate: 19, taxTreatment: 'gravado' as const, taxBase: 8_403, taxAmount: 1_597 },
    ],
    total: 40_000,
    tip: 3_000,
  };
  const venta = {
    _id: saleId,
    sedeId,
    status: 'completed',
    saleNumber: 'FV-000010',
    payment: { method: 'cash' },
    ...ventaDoc,
    lines: ventaDoc.lines.map((l, i) => ({ ...l, productId: i === 0 ? HAMB : GAS })),
  };
  const armado = documentoDeVenta(ventaDoc);

  const referido = (type: 'invoice' | 'pos', o: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    type,
    saleId,
    ventaFiscal: saleId,
    sedeId: new Types.ObjectId(sedeId),
    fullNumber: type === 'pos' ? 'POS15' : 'FE15',
    issueDate: '2026-11-01',
    cufe: 'c'.repeat(96),
    emisor: { name: 'Negocio', nit: '900123456', nitNorm: '900123456', nitDv: '8', tipoPersona: 'juridica', address: 'Cra 1', departamento: '11', ciudad: 'Bogotá' },
    adquiriente: { docType: '13', docNumber: '222222222222' },
    lines: armado.lines,
    charges: armado.charges,
    ...armado.totales,
    formaPago: '1',
    medioPago: '10',
    dianStatus: 'accepted',
    ...o,
  });

  let doc: any;
  let previas: any[];
  let porOrigen: any;
  let pin: string | null;
  let model: any;
  let counters: any;
  let businesses: any;
  let sales: any;
  let svc: EinvoicingService;

  const cadena = (v: unknown): any => {
    const c: any = { sort: () => c, select: () => c, lean: () => c, exec: () => Promise.resolve(v) };
    return c;
  };

  beforeEach(() => {
    doc = referido('invoice');
    previas = [];
    porOrigen = null;
    pin = '12345';
    let seq = 0;
    model = {
      findOne: vi.fn((f: any) => {
        if (f.origenNota) return cadena(porOrigen);
        if (f.ventaFiscal) return cadena(doc?.ventaFiscal ? doc : null);
        if (f.saleId) return cadena(doc);
        return cadena(null);
      }),
      findById: vi.fn(() => cadena(doc)),
      find: vi.fn(() => cadena(previas)),
      updateOne: vi.fn(() => cadena({})),
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
      findById: vi.fn(async () => ({})),
    };
    const sedes = { findOrFail: vi.fn(async () => ({ id: sedeId, nit: '900123456', resolucionesFe: [] })) };
    sales = { getOrFail: vi.fn(async () => venta), void: vi.fn(async () => ({ ...venta, status: 'void' })) };
    const emisores = {
      obtenerPorSede: vi.fn(async () => ({ id: 'e1', tipoAmbiente: '2' })),
      leerSecreto: vi.fn(async () => pin),
    };
    svc = new EinvoicingService(model, counters, sales, sedes as any, businesses, emisores as any);
  });

  const enTenant = <T>(fn: () => Promise<T>) => TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, fn);
  const devolucion = (lineas = [{ productId: HAMB.toString(), qty: 1, valor: 10_000, impuesto: 741 }]) =>
    enTenant(() =>
      svc.emitirNotaDeVenta({ saleId: saleId.toString(), origen: 'devolucion:r1', concepto: '1', motivo: 'Devolución de la venta FV-000010', lineas }, user),
    );

  const ubl = (n: any) => prepararNotaUbl(n, { facturaSoftwareId: 'sw', municipioDane: '11001' });
  const rebaja = (concepto: string, lineas = [{ productId: HAMB.toString(), qty: 0, valor: 3_000, impuesto: 222 }]) =>
    enTenant(() =>
      svc.emitirNotaDeVenta(
        { saleId: saleId.toString(), origen: 'rebaja:r1', concepto: concepto as never, motivo: 'Rebaja por queja', lineas },
        user,
      ),
    );

  it('FEV, concepto 5: línea por valor (cantidad 1 informativa), sin propina, y el builder la arma', async () => {
    const r: any = await rebaja('5');
    const n = r.nota;
    expect(n.discrepancyCode).toBe('5');
    expect(n.charges).toBeUndefined();
    expect(n.lines[0]).toMatchObject({ refKey: HAMB.toString(), qty: 1, unitPrice: 2_778, base: 2_778, taxAmount: 222, sinCantidad: true });
    expect(n.payableAmount).toBe(3_000);
    expect(ubl(n).concepto.codigo).toBe('5');
  });

  it('POS: los descuentos comerciales 5 y 6 son 400; el 3 sale como nota de ajuste', async () => {
    doc = referido('pos');
    await expect(rebaja('5')).rejects.toBeInstanceOf(BadRequestException);
    await expect(rebaja('6')).rejects.toThrow(/concepto 3/);
    const r: any = await rebaja('3');
    expect(r.nota).toMatchObject({ fullNumber: 'NAC1', referenceType: 'pos', discrepancyCode: '3' });
  });

  it('la rebaja no consume unidades: después cabe devolver las 3 hamburguesas por lo que queda', async () => {
    previas = [{ lines: [{ refKey: HAMB.toString(), qty: 1, base: 2_778, taxScheme: '04', taxAmount: 222, sinCantidad: true }] }];
    const r: any = await devolucion([{ productId: HAMB.toString(), qty: 3, valor: 27_000, impuesto: 2_000 }]);
    expect(r.nota.lines[0].qty).toBe(3);
    // Pero no por el valor entero: lo rebajado ya salió.
    previas = [{ lines: [{ refKey: HAMB.toString(), qty: 1, base: 2_778, taxScheme: '04', taxAmount: 222, sinCantidad: true }] }];
    await expect(devolucion([{ productId: HAMB.toString(), qty: 3, valor: 30_000, impuesto: 2_222 }])).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('tope cruzado: lo que una nota sin referencia le asignó a la factura cuenta contra la rebaja posterior', async () => {
    // La sin referencia ya le asignó $6.000 (con $444 de INC) a las hamburguesas de esta factura.
    previas = [
      {
        type: 'credit_note',
        lines: [{ refKey: 'tributo:04:8', qty: 1, base: 9_000, taxScheme: '04', taxAmount: 720, sinCantidad: true }],
        asignaciones: [{ referenceId: doc._id, refKey: HAMB.toString(), taxScheme: '04', taxRate: 8, base: 5_556, taxAmount: 444 }],
      },
    ];
    await expect(rebaja('3', [{ productId: HAMB.toString(), qty: 0, valor: 24_001, impuesto: 1_778 }])).rejects.toBeInstanceOf(
      ConflictException,
    );
    const r: any = await rebaja('3', [{ productId: HAMB.toString(), qty: 0, valor: 24_000, impuesto: 1_778 }]);
    expect(r.nota.payableAmount).toBe(24_000);
  });

  it('concepto desconocido: 400', async () => {
    await expect(rebaja('7')).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('nota sin referencia (CustomizationID 22)', () => {
    const pedir = (o: Record<string, unknown> = {}) =>
      enTenant(() =>
        svc.emitirNotaSinReferencia(
          {
            origen: 'sin_referencia:x1',
            sedeId,
            docNumber: '900555111',
            concepto: '6',
            motivo: 'Descuento por volumen de noviembre',
            desde: '2026-11-01',
            hasta: '2026-11-30',
            monto: 4_000,
            ...o,
          } as never,
          user,
        ),
      );
    let facturas: any[];
    beforeEach(() => {
      facturas = [referido('invoice', { adquiriente: { docType: '13', docNumber: '900555111', name: 'Cliente Empresa', tipoPersona: '2', responsabilidades: ['R-99-PN'], municipioDane: '11001', address: 'Cra 1', email: 'c@e.co' } })];
      model.find = vi.fn((f: any) => cadena(f.type === 'invoice' ? facturas : []));
    });

    it('reparte el monto por tributo de las facturas del periodo, sin referencia y con el periodo', async () => {
      const n: any = await pedir();
      expect(n.referenceNumber).toBeUndefined();
      expect(n.referenceId).toBeUndefined();
      expect(n.period).toEqual({ desde: '2026-11-01', hasta: '2026-11-30' });
      expect(n.discrepancyCode).toBe('6');
      expect(n.payableAmount).toBe(4_000);
      // $30.000 con INC y $10.000 con IVA → $3.000 y $1.000, con su impuesto.
      const porTributo = Object.fromEntries(n.lines.map((l: any) => [l.taxScheme, [l.total, l.taxAmount]]));
      expect(porTributo).toEqual({ '04': [3_000, 222], '01': [1_000, 160] });
      // El reparto queda guardado por factura y producto (tope cruzado).
      expect(n.asignaciones.map((x: any) => [String(x.referenceId), x.refKey, x.base + x.taxAmount, x.taxAmount])).toEqual([
        [String(facturas[0]._id), HAMB.toString(), 3_000, 222],
        [String(facturas[0]._id), GAS.toString(), 1_000, 160],
      ]);
      const u: any = ubl(n);
      expect(u.referencia).toBeUndefined();
      expect(u.periodo).toEqual({ desde: '2026-11-01', hasta: '2026-11-30' });
      // Busca las facturas del cliente con y sin formato del documento.
      expect(model.find.mock.calls[0][0]['adquiriente.docNumber']).toEqual({ $in: ['900555111'] });
    });

    it('el tope es lo facturado en el periodo: 409 si pasa', async () => {
      await expect(pedir({ monto: 40_001 })).rejects.toBeInstanceOf(ConflictException);
    });

    it('sin facturas en el periodo: 400 (un POS no admite nota sin referencia)', async () => {
      facturas = [];
      await expect(pedir()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('periodo de más de un mes, concepto 2 o sin motivo: 400 antes de buscar nada', async () => {
      await expect(pedir({ desde: '2026-10-25', hasta: '2026-11-05' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(pedir({ concepto: '2' })).rejects.toBeInstanceOf(BadRequestException);
      expect(model.find).not.toHaveBeenCalled();
    });

    it('idempotente por operación: devuelve la nota ya emitida', async () => {
      porOrigen = { _id: new Types.ObjectId(), dianStatus: 'draft', fullNumber: 'NC9' };
      await expect(pedir()).resolves.toBe(porOrigen);
      expect(model.create).not.toHaveBeenCalled();
    });
  });
});
