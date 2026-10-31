import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

// Patrón de `orders.service.checkout.spec.ts`: se neutralizan los decoradores
// de los esquemas que importa el servicio.
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

import { EinvoicingService, MENSAJE_POS_SIN_PIN } from './einvoicing.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { calcularCudePos, dianVerificationUrl } from '../domain/cufe';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Emisión del documento equivalente electrónico POS (PR 7B). Constructor:
 * (model, counters, sales, sedes, businesses, emisores).
 */
describe('EinvoicingService.createPosFromSale', () => {
  const sedeId = new Types.ObjectId().toString();
  const saleId = new Types.ObjectId();
  const user = { email: 'cajero@x.co', role: 'cashier', permissions: ['pos.sell'], sedeIds: [sedeId] } as unknown as JwtUser;

  const choque = (keyPattern: Record<string, number>) =>
    Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern });

  let seq: number;
  let previo: any;
  let existentePos: any;
  let resolucionPos: any;
  let pin: string | null;
  let saleData: any;
  let model: any;
  let counters: any;
  let businesses: any;
  let svc: EinvoicingService;

  const sede = () => ({
    id: sedeId,
    code: 'centro',
    name: 'Sede Centro',
    address: 'Cra 1 # 2-3',
    nit: '900.123.456-7',
    resolucionFe: { prefijo: 'FE', rangoDesde: 1, rangoHasta: 1000, claveTecnica: 'clave' },
    resolucionesFe: resolucionPos ? [resolucionPos] : [],
    puntosVenta: [{ placa: 'CAJA-01', ubicacion: 'Mostrador', tipo: 'Caja' }],
  });

  const emitir = (modo: 'anonimo' | 'identificado' = 'anonimo') =>
    TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, () =>
      svc.createPosFromSale(saleId.toString(), modo, user),
    );

  beforeEach(() => {
    seq = 0;
    previo = null;
    existentePos = null;
    pin = 'pin-software';
    resolucionPos = {
      tipoDocumento: 'pos',
      prefijo: 'POS',
      rangoDesde: 100,
      rangoHasta: 200,
      numero: '18760000001',
    };
    saleData = {
      _id: saleId,
      sedeId,
      saleNumber: 'FV-000007',
      status: 'completed',
      cashierEmail: 'cajero@x.co',
      cashierName: 'Ana',
      lines: [],
      payment: { method: 'cash' },
      total: 0,
      customer: { name: 'Ana Pérez', idNumber: '1020304050', docType: '13' },
    };
    model = {
      findOne: vi.fn((q: any) => {
        const valor = q?.$or ? null : q?.type?.$in ? previo : existentePos;
        const c: any = { sort: () => c, select: () => c, lean: () => c, exec: () => Promise.resolve(valor) };
        return c;
      }),
      create: vi.fn(async (d: any) => ({ ...d, _id: 'doc' })),
    };
    counters = {
      findOneAndUpdate: vi.fn((filtro: any, upd: any) => ({
        exec: async () => {
          if (upd.$inc?.seq === 1) return { seq: ++seq };
          if (upd.$inc?.seq === -1) {
            if (filtro.seq === seq) seq -= 1;
            return { seq };
          }
          if (upd.$max) seq = Math.max(seq, upd.$max.seq);
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
      {
        obtenerPorSede: async () => ({ id: 'e1', tipoAmbiente: '2' }),
        leerSecreto: vi.fn(async () => pin),
      } as any,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  const nadaConsumido = () => {
    expect(businesses.consumeDocument).not.toHaveBeenCalled();
    expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  };

  it('sin resolución POS: 400 antes de cupo y folio', async () => {
    resolucionPos = undefined;
    await expect(emitir()).rejects.toThrow(/resolución .*POS/i);
    nadaConsumido();
  });

  it('resolución POS vencida: 400 antes de cupo y folio', async () => {
    resolucionPos.vigenciaHasta = new Date('2020-01-01');
    await expect(emitir()).rejects.toBeInstanceOf(BadRequestException);
    nadaConsumido();
  });

  it('sin PIN del software: 400 antes de cupo y folio (la clave técnica no hace falta)', async () => {
    pin = null;
    await expect(emitir()).rejects.toThrow(MENSAJE_POS_SIN_PIN);
    nadaConsumido();
  });

  it('identificado sin los datos mínimos: 400 que dice qué falta, sin cupo ni folio', async () => {
    saleData.customer = { name: 'Ana' };
    await expect(emitir('identificado')).rejects.toThrow(/tipo de documento/);
    nadaConsumido();
  });

  it('anónimo: POS con la numeración POS, consumidor final, CUDE con el PIN y QR', async () => {
    const doc: any = await emitir();
    expect(counters.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: `fe:pos:${sedeId}:POS` });
    expect(doc).toMatchObject({
      type: 'pos',
      prefix: 'POS',
      number: 100,
      fullNumber: 'POS100',
      dianStatus: 'draft',
      tipoAmbiente: '2',
      ventaFiscal: saleId,
      adquiriente: { docType: '13', docNumber: '222222222222', name: 'Consumidor final' },
      cajaVenta: { placa: 'CAJA-01', ubicacion: 'Mostrador', tipo: 'Caja', cajero: 'Ana', codigoVenta: 'FV-000007' },
      fabricante: { nombreSoftware: expect.any(String), nombreApellido: expect.any(String) },
      pagos: [{ metodo: 'cash', monto: 0, formaPago: '1' }],
      resolution: { prefijo: 'POS', numero: '18760000001' },
    });
    const cude = calcularCudePos({
      numero: 'POS100',
      fecha: doc.issueDate,
      hora: doc.issueTime,
      valorBruto: 0,
      impuestos: { '01': 0, '04': 0, '03': 0 },
      valorTotal: 0,
      nitEmisor: '900123456',
      numAdquiriente: '222222222222',
      softwarePin: 'pin-software',
      tipoAmbiente: '2',
    });
    expect(doc.cufe).toBe(cude);
    expect(doc.qrUrl).toBe(dianVerificationUrl(cude, '2'));
    expect(businesses.consumeDocument).toHaveBeenCalledTimes(1);
  });

  it('identificado: el adquiriente es el cliente y entra en el CUDE', async () => {
    const doc: any = await emitir('identificado');
    expect(doc.adquiriente).toMatchObject({ docType: '13', docNumber: '1020304050', name: 'Ana Pérez' });
    const cude = calcularCudePos({
      numero: doc.fullNumber,
      fecha: doc.issueDate,
      hora: doc.issueTime,
      valorBruto: 0,
      impuestos: { '01': 0, '04': 0, '03': 0 },
      valorTotal: 0,
      nitEmisor: '900123456',
      numAdquiriente: '1020304050',
      softwarePin: 'pin-software',
      tipoAmbiente: '2',
    });
    expect(doc.cufe).toBe(cude);
  });

  it('idempotente: si la venta ya tiene su POS (doble clic) lo devuelve sin cobrar cupo', async () => {
    previo = { _id: 'pos-previo', type: 'pos' };
    await expect(emitir()).resolves.toBe(previo);
    nadaConsumido();
  });

  it('exclusión: si la venta ya tiene FEV, 409 sin cupo ni folio', async () => {
    previo = { _id: 'fev', type: 'invoice' };
    await expect(emitir()).rejects.toBeInstanceOf(ConflictException);
    nadaConsumido();
  });

  it('exclusión en carrera (choca el índice): devuelve cupo y folio y responde 409', async () => {
    model.create.mockImplementation(async () => {
      throw choque({ ventaFiscal: 1 });
    });
    await expect(emitir()).rejects.toBeInstanceOf(ConflictException);
    expect(businesses.refundDocument).toHaveBeenCalledTimes(1);
    expect(seq).toBe(0);
  });

  it('doble clic en carrera (choca el índice de exclusión con otro POS): devuelve el POS ganador', async () => {
    existentePos = { _id: 'ganador', type: 'pos' };
    model.create.mockImplementation(async () => {
      throw choque({ ventaFiscal: 1 });
    });
    await expect(emitir()).resolves.toBe(existentePos);
    expect(businesses.refundDocument).toHaveBeenCalledTimes(1);
    expect(seq).toBe(0);
  });

  it('la fecha y la hora se toman una sola vez: un reintento por choque de número no las cambia', async () => {
    let t = Date.parse('2026-10-31T17:59:59Z');
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 2000));
    model.create
      .mockImplementationOnce(async () => {
        throw choque({ 'emisor.nitNorm': 1, prefix: 1, number: 1 });
      })
      .mockImplementation(async (d: any) => ({ ...d, _id: 'doc' }));
    await emitir();
    const [primero, segundo] = model.create.mock.calls.map((c: any[]) => c[0]);
    expect(segundo.issueDate).toBe(primero.issueDate);
    expect(segundo.issueTime).toBe(primero.issueTime);
  });

  it('venta anulada: 400', async () => {
    saleData.status = 'void';
    await expect(emitir()).rejects.toBeInstanceOf(BadRequestException);
    nadaConsumido();
  });
});

describe('EinvoicingService.createFromSale · exclusión con el POS', () => {
  it('si la venta ya tiene POS, la FEV es un 409 sin cupo ni folio', async () => {
    const sedeId = new Types.ObjectId().toString();
    const saleId = new Types.ObjectId();
    const user = { email: 'a@b.co', permissions: [], sedeIds: [sedeId] } as unknown as JwtUser;
    const pos = { _id: 'pos', type: 'pos' };
    const model: any = {
      findOne: vi.fn(() => ({ exec: async () => pos })),
      create: vi.fn(),
    };
    const businesses: any = { consumeDocument: vi.fn(), refundDocument: vi.fn() };
    const svc = new EinvoicingService(
      model,
      { findOneAndUpdate: vi.fn() } as any,
      { getOrFail: async () => ({ _id: saleId, sedeId, status: 'completed', lines: [], payment: { method: 'cash' }, total: 0 }) } as any,
      { findOrFail: vi.fn() } as any,
      businesses,
      {} as any,
    );
    await expect(svc.createFromSale(saleId.toString(), user)).rejects.toBeInstanceOf(ConflictException);
    expect(businesses.consumeDocument).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });
});
