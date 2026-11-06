import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
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

import {
  EinvoicingService,
  MENSAJE_NOTA_SIN_PIN,
  MENSAJE_SIN_DOCUMENTO_FISCAL,
} from './einvoicing.service';
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
const sha384 = (s: string) => createHash('sha384').update(s, 'utf8').digest('hex');

describe('EinvoicingService · notas de la venta (Fase 6B)', () => {
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
  const anulacion = () =>
    enTenant(() =>
      svc.emitirNotaDeVenta({ saleId: saleId.toString(), origen: `anulacion:${saleId}`, concepto: '2', motivo: 'Anulación' }, user),
    );

  it('FEV → nota crédito NC con referenceType invoice, CUFE referido y concepto 1', async () => {
    const r: any = await devolucion();
    expect(r.estado).toBe('emitida');
    const n = r.nota;
    expect(n).toMatchObject({
      type: 'credit_note',
      fullNumber: 'NC1',
      discrepancyCode: '1',
      referenceType: 'invoice',
      referenceScheme: 'CUFE-SHA384',
      referenceNumber: 'FE15',
      referenceIssueDate: '2026-11-01',
      origenNota: 'devolucion:r1',
      dianStatus: 'draft',
    });
    // Sin `saleId`: el índice saleId+type dejaría una sola nota por venta.
    expect(n.saleId).toBeUndefined();
    expect(n.notaDeVenta).toBe(saleId);
    expect(n.lines).toHaveLength(1);
    expect(n.lines[0]).toMatchObject({ refKey: HAMB.toString(), qty: 1, taxScheme: '04', base: 9_259, taxAmount: 741 });
    expect(n.charges).toBeUndefined();
    expect(n.payableAmount).toBe(10_000);
    // CUDE con los valores DE LA NOTA (no los de la factura) y el PIN.
    expect(n.cufe).toBe(
      sha384(
        'NC1' + n.issueDate + n.issueTime + '9259.00' + '01' + '0.00' + '04' + '741.00' + '03' + '0.00' + '10000.00' +
          '900123456' + '222222222222' + '12345' + '2',
      ),
    );
    // Y el builder la acepta: concepto, referencia y cuadre.
    const ubl = prepararNotaUbl(n, { facturaSoftwareId: 'sw', municipioDane: '11001' });
    expect(ubl.origen).toBe('factura');
  });

  it('POS → nota de ajuste NAC con referenceType pos y CUDE referido', async () => {
    doc = referido('pos');
    const r: any = await devolucion();
    expect(r.nota).toMatchObject({ fullNumber: 'NAC1', referenceType: 'pos', referenceScheme: 'CUDE-SHA384', referenceNumber: 'POS15' });
    expect(counters.findOneAndUpdate.mock.calls[0][0]._id).toBe(`nac:${sedeId}`);
    expect(prepararNotaUbl(r.nota, { facturaSoftwareId: 'sw', municipioDane: '11001' }).origen).toBe('pos');
  });

  it('anulación total: concepto 2, todas las líneas y la propina', async () => {
    const r: any = await anulacion();
    expect(r.nota.discrepancyCode).toBe('2');
    expect(r.nota.lines).toHaveLength(2);
    expect(r.nota.charges).toEqual([{ chargeIndicator: true, reason: 'Propina voluntaria', amount: 3_000 }]);
    expect(r.nota.payableAmount).toBe(43_000);
  });

  it('venta sin documento fiscal: no emite nota y lo dice', async () => {
    doc = null;
    const r = await devolucion();
    expect(r).toEqual({ estado: 'sin_nota', motivo: MENSAJE_SIN_DOCUMENTO_FISCAL });
    expect(model.create).not.toHaveBeenCalled();
    expect(businesses.consumeDocument).not.toHaveBeenCalled();
  });

  it('documento rechazado por la DIAN: no existe ante ella, sin nota', async () => {
    doc = referido('invoice', { dianStatus: 'rejected' });
    const r: any = await devolucion();
    expect(r.estado).toBe('sin_nota');
    expect(r.motivo).toMatch(/rechazado/);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('idempotente por operación: el reintento devuelve la misma nota sin cupo ni folio', async () => {
    porOrigen = { _id: new Types.ObjectId(), origenNota: 'devolucion:r1', dianStatus: 'sent' };
    const r: any = await devolucion();
    expect(r).toEqual({ estado: 'emitida', nota: porOrigen });
    expect(model.create).not.toHaveBeenCalled();
    expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('si la nota de la operación fue rechazada, libera la llave y emite otra', async () => {
    const rechazada = { _id: new Types.ObjectId(), origenNota: 'devolucion:r1', dianStatus: 'rejected' };
    let primera = true;
    model.findOne = vi.fn((f: any) => {
      if (f.origenNota) {
        const v = primera ? rechazada : null;
        primera = false;
        return cadena(v);
      }
      return cadena(doc);
    });
    const r: any = await devolucion();
    expect(r.estado).toBe('emitida');
    expect(model.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: rechazada._id, dianStatus: 'rejected' }),
      { $set: { origenNota: `devolucion:r1#rechazada:${String(rechazada._id)}` } },
    );
    expect(model.create).toHaveBeenCalledTimes(1);
  });

  it('por encima de lo que queda por acreditar → 409 sin cupo ni folio', async () => {
    previas = [{ lines: [{ refKey: HAMB.toString(), qty: 3, base: 27_778, taxScheme: '04', taxAmount: 2_222 }] }];
    const err = await devolucion().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/excede/);
    expect(model.create).not.toHaveBeenCalled();
    expect(businesses.consumeDocument).not.toHaveBeenCalled();
  });

  it('las notas previas se buscan del mismo documento y sin las rechazadas', async () => {
    await devolucion();
    // Fase 6C: también las notas sin referencia que le asignaron parte (tope cruzado).
    expect(model.find).toHaveBeenCalledWith({
      type: 'credit_note',
      dianStatus: { $ne: 'rejected' },
      $or: [{ referenceId: doc._id }, { 'asignaciones.referenceId': doc._id }],
    });
  });

  it('anulación con una NC vieja por el total (antes de la Fase 6B): la reutiliza, no emite otra', async () => {
    const vieja = { _id: new Types.ObjectId(), type: 'credit_note', fullNumber: 'NC3', lines: [{ qty: 3, base: 1, taxAmount: 0 }] };
    previas = [vieja];
    const r = await anulacion();
    expect(r).toEqual({ estado: 'emitida', nota: vieja });
    expect(model.create).not.toHaveBeenCalled();
  });

  it('devolución con una NC vieja por el total → 409 (ya no queda saldo)', async () => {
    previas = [{ lines: [{ qty: 3, base: 1, taxAmount: 0 }] }];
    await expect(devolucion()).rejects.toBeInstanceOf(ConflictException);
  });

  it('anulación con notas parciales previas → 409', async () => {
    previas = [{ lines: [{ refKey: GAS.toString(), qty: 1, base: 4_201, taxScheme: '01', taxAmount: 799 }] }];
    await expect(anulacion()).rejects.toBeInstanceOf(ConflictException);
  });

  it('sin PIN: falla cerrado antes de cupo y folio', async () => {
    pin = null;
    const err = await devolucion().catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(MENSAJE_NOTA_SIN_PIN);
    expect(businesses.consumeDocument).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });

  it('si la nota alcanzó a guardarse y algo falla después, devuelve la guardada', async () => {
    const guardada = { _id: new Types.ObjectId(), origenNota: 'devolucion:r1', dianStatus: 'draft' };
    let llamadas = 0;
    model.findOne = vi.fn((f: any) => {
      if (f.origenNota) return cadena(llamadas++ === 0 ? null : guardada);
      return cadena(doc);
    });
    model.create = vi.fn(async () => {
      throw new Error('fallo después de guardar');
    });
    const r: any = await devolucion();
    expect(r).toEqual({ estado: 'emitida', nota: guardada });
  });

  describe('createCreditNote (anula la venta con su nota)', () => {
    const anular = () => enTenant(() => svc.createCreditNote(String(doc._id), 'Error de cobro', user));

    it('venta vigente: delega en SalesService.void, que reversa el libro y emite la nota', async () => {
      model.findById = vi.fn(() => cadena(doc));
      const nota = { _id: new Types.ObjectId(), type: 'credit_note' };
      model.findOne = vi.fn((f: any) => (f.origenNota ? cadena(nota) : cadena(doc)));
      const r = await anular();
      expect(sales.void).toHaveBeenCalledWith(saleId.toString(), user, { motivo: 'Error de cobro' });
      expect(r).toBe(nota);
    });

    it('sin permiso de autorizar anulaciones: 403 y la venta no se toca', async () => {
      const cajero = { ...user, permissions: ['einvoicing.void'] } as unknown as JwtUser;
      const err = await enTenant(() => svc.createCreditNote(String(doc._id), 'x', cajero)).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(sales.void).not.toHaveBeenCalled();
    });

    it('documento rechazado: 400 sin tocar la venta', async () => {
      doc = referido('invoice', { dianStatus: 'rejected' });
      await expect(anular()).rejects.toBeInstanceOf(BadRequestException);
      expect(sales.void).not.toHaveBeenCalled();
    });

    it('venta ya anulada (antes de la Fase 6B): solo emite la nota, el libro ya se reversó', async () => {
      sales.getOrFail = vi.fn(async () => ({ ...venta, status: 'void' }));
      const r: any = await anular();
      expect(sales.void).not.toHaveBeenCalled();
      expect(r.discrepancyCode).toBe('2');
      expect(r.origenNota).toBe(`anulacion:${saleId}`);
    });
  });
});
