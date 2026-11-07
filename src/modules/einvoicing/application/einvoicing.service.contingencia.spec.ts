import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

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

import { EinvoicingService, MENSAJE_SIN_NUMERACION_CONTINGENCIA } from './einvoicing.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { calcularCude } from '../domain/cufe';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Transcripción de contingencia del facturador (Fase 9): POS 07 / FEV 03 con
 * la numeración de contingencia, la fecha real de la venta y el CUDE con el PIN.
 */
describe('EinvoicingService.transcribirContingencia', () => {
  const sedeId = new Types.ObjectId().toString();
  const saleId = new Types.ObjectId();
  const user = { email: 'admin@x.co', role: 'admin', permissions: ['einvoicing.issue'], sedeIds: [sedeId] } as unknown as JwtUser;
  const choque = (keyPattern: Record<string, number>) =>
    Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern });

  let seq: number;
  let previo: any;
  let resolucionCont: any;
  let pin: string | null;
  let saleData: any;
  let model: any;
  let counters: any;
  let businesses: any;
  let svc: EinvoicingService;

  const sede = () => ({
    id: sedeId,
    name: 'Sede Centro',
    nit: '900.123.456-7',
    resolucionFe: { prefijo: 'FE', rangoDesde: 1, rangoHasta: 1000, claveTecnica: 'clave' },
    resolucionesFe: resolucionCont ? [resolucionCont] : [],
    puntosVenta: [{ placa: 'CAJA-01', ubicacion: 'Mostrador', tipo: 'Caja' }],
  });

  const transcribir = (tipo: 'pos' | 'invoice' = 'pos', talonario?: { numero: number; fecha: string }) =>
    TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, () =>
      svc.transcribirContingencia(saleId.toString(), tipo === 'pos' ? { tipo, modo: 'anonimo' } : { tipo }, { talonario }, user),
    );

  beforeEach(() => {
    seq = 0;
    previo = null;
    pin = 'pin-software';
    resolucionCont = {
      tipoDocumento: 'contingency',
      prefijo: 'CONT',
      rangoDesde: 1,
      rangoHasta: 500,
      numero: '18764000777',
      vigenciaDesde: new Date('2026-01-01T00:00:00Z'),
      vigenciaHasta: new Date('2099-12-31T00:00:00Z'),
    };
    saleData = {
      _id: saleId,
      sedeId,
      saleNumber: 'FV-000042',
      status: 'void',
      cashierEmail: 'cajero@x.co',
      cashierName: 'Ana',
      lines: [],
      payment: { method: 'cash' },
      total: 0,
      // Cobrada sin conexión el 4 a las 20:15 (Colombia); llegó al servidor el 5.
      soldAt: new Date('2026-11-05T01:15:00Z'),
      createdAt: new Date('2026-11-05T14:00:00Z'),
    };
    model = {
      findOne: vi.fn(() => {
        const c: any = { sort: () => c, select: () => c, lean: () => c, exec: () => Promise.resolve(previo) };
        return c;
      }),
      create: vi.fn(async (d: any) => ({ ...d, _id: 'doc' })),
    };
    counters = {
      findOneAndUpdate: vi.fn((_f: any, upd: any) => ({
        exec: async () => {
          if (upd.$inc?.seq === 1) return { seq: ++seq };
          if (upd.$inc?.seq === -1) return { seq: --seq };
          return { seq };
        },
      })),
    };
    businesses = {
      consumeDocument: vi.fn(async () => 'monthly'),
      refundDocument: vi.fn(async () => undefined),
      findById: vi.fn(async () => null),
    };
    svc = new EinvoicingService(
      model,
      counters,
      { getOrFail: vi.fn(async () => saleData) } as any,
      { findOrFail: vi.fn(async () => sede()) } as any,
      businesses,
      { obtenerPorSede: async () => ({ id: 'e1', tipoAmbiente: '1' }), leerSecreto: vi.fn(async () => pin) } as any,
      { record: vi.fn(async () => undefined) } as any,
    );
  });

  it('POS 07 de una venta sin conexión (aunque luego se anuló): numeración de contingencia, fecha real, CUDE con el PIN y plazo desde que llegó', async () => {
    const doc: any = await transcribir();
    expect(counters.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: `fe:contingency:${sedeId}:CONT` });
    expect(doc).toMatchObject({
      type: 'pos',
      fullNumber: 'CONT1',
      issueDate: '2026-11-04',
      issueTime: '20:15:00-05:00',
      dianStatus: 'draft',
      ventaFiscal: saleId,
      resolution: { prefijo: 'CONT', numero: '18764000777' },
      contingencia: {
        tipo: '07',
        superadaAt: saleData.createdAt,
        referencia: { id: 'FV-000042', fecha: '2026-11-04' },
      },
    });
    const cude = calcularCude({
      numero: 'CONT1',
      fecha: '2026-11-04',
      hora: '20:15:00-05:00',
      valorBruto: 0,
      impuestos: { '01': 0, '04': 0, '03': 0 },
      valorTotal: 0,
      nitEmisor: '900123456',
      numAdquiriente: '222222222222',
      softwarePin: 'pin-software',
      tipoAmbiente: '1',
    });
    expect(doc.cufe).toBe(cude);
  });

  it('FEV 03 con talonario: el número impreso, su fecha en la referencia y sin tomar folio del contador', async () => {
    const doc: any = await transcribir('invoice', { numero: 7, fecha: '2026-11-04' });
    expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
    expect(doc).toMatchObject({
      type: 'invoice',
      fullNumber: 'CONT7',
      number: 7,
      contingencia: { tipo: '03', referencia: { id: 'CONT7', fecha: '2026-11-04' } },
    });
  });

  it('talonario fuera de rango o con fecha futura: 400 antes de cupo y folio', async () => {
    await expect(transcribir('invoice', { numero: 900, fecha: '2026-11-04' })).rejects.toThrow(/no está en la numeración/);
    await expect(transcribir('invoice', { numero: 7, fecha: '2098-01-01' })).rejects.toBeInstanceOf(BadRequestException);
    expect(businesses.consumeDocument).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });

  it('talonario ya transcrito: 409 y el cupo vuelve', async () => {
    model.create.mockRejectedValueOnce(choque({ 'emisor.nitNorm': 1, prefix: 1, number: 1 }));
    await expect(transcribir('invoice', { numero: 7, fecha: '2026-11-04' })).rejects.toThrow(/ya fue transcrito/);
    expect(businesses.refundDocument).toHaveBeenCalledTimes(1);
  });

  it('sin numeración de contingencia o sin PIN: 400 sin consumir nada', async () => {
    resolucionCont = undefined;
    await expect(transcribir()).rejects.toThrow(MENSAJE_SIN_NUMERACION_CONTINGENCIA);
    resolucionCont = { tipoDocumento: 'contingency', prefijo: 'CONT', rangoDesde: 1, rangoHasta: 9 };
    pin = null;
    await expect(transcribir()).rejects.toBeInstanceOf(BadRequestException);
    expect(businesses.consumeDocument).not.toHaveBeenCalled();
  });

  it('idempotente: devuelve el ya transcrito; un documento normal de la venta es 409', async () => {
    previo = { type: 'pos', contingencia: { tipo: '07' }, fullNumber: 'CONT1' };
    await expect(transcribir()).resolves.toBe(previo);
    previo = { type: 'pos', fullNumber: 'POS100' };
    await expect(transcribir()).rejects.toBeInstanceOf(ConflictException);
    expect(model.create).not.toHaveBeenCalled();
  });
});
