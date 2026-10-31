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

// `waitUntil` de Vercel: se capturan las promesas que quedan corriendo tras responder.
const enSegundoPlano: Promise<unknown>[] = [];
vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => void enSegundoPlano.push(p),
}));

import { DocumentoFiscalVentaService } from './documento-fiscal-venta.service';
import type { EmisionDocumentoFiscal } from './emision-documento-fiscal.puerto';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Disparo del documento fiscal desde el cobro (PR 7B): después de confirmar la
 * venta, sin bloquearla y sin revertirla nunca.
 */
describe('DocumentoFiscalVentaService.alCobrar', () => {
  const user = { userId: 'u1', email: 'cajero@x.co', sedeIds: [], permissions: ['pos.sell'] } as unknown as JwtUser;
  const emitido = {
    documentoId: 'd1',
    tipo: 'pos' as const,
    fullNumber: 'POS100',
    cude: 'abc',
    qrUrl: 'https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=abc',
    dianStatus: 'draft',
  };

  let puerto: { emitir: ReturnType<typeof vi.fn>; transmitir: ReturnType<typeof vi.fn> };
  let saleModel: any;
  let moduleRef: any;
  let svc: DocumentoFiscalVentaService;
  let sale: any;

  beforeEach(() => {
    enSegundoPlano.length = 0;
    puerto = {
      emitir: vi.fn(async () => emitido),
      transmitir: vi.fn(async () => undefined),
    };
    saleModel = { updateOne: vi.fn(() => ({ exec: async () => ({}) })) };
    moduleRef = { get: vi.fn(() => puerto as unknown as EmisionDocumentoFiscal) };
    svc = new DocumentoFiscalVentaService(moduleRef, saleModel, 50);
    sale = { _id: new Types.ObjectId(), total: 1000 };
  });

  it('sin documentoFiscal no emite nada (compatible con el Frontend actual)', async () => {
    const r = await svc.alCobrar(sale, undefined, user);
    expect(r).toBe(sale);
    expect(moduleRef.get).not.toHaveBeenCalled();
    expect(saleModel.updateOne).not.toHaveBeenCalled();
    expect(sale.documentoFiscal).toBeUndefined();
  });

  it('POS anónimo: lo emite, lo guarda en la venta, lo devuelve y transmite en segundo plano', async () => {
    const r: any = await svc.alCobrar(sale, 'pos_anonimo', user);
    expect(puerto.emitir).toHaveBeenCalledWith(sale._id.toString(), 'pos_anonimo', user);
    expect(r.documentoFiscal).toEqual({ solicitado: 'pos_anonimo', estado: 'emitido', ...emitido });
    expect(saleModel.updateOne).toHaveBeenCalledWith(
      { _id: sale._id, 'documentoFiscal.estado': { $ne: 'emitido' } },
      { $set: { documentoFiscal: r.documentoFiscal } },
    );
    // La transmisión no la espera el cobro: queda en waitUntil.
    expect(enSegundoPlano).toHaveLength(1);
    await Promise.all(enSegundoPlano);
    expect(puerto.transmitir).toHaveBeenCalledWith('d1', user);
  });

  it('un error del emisor (p. ej. sin resolución POS) no rompe el cobro: queda en error con el motivo', async () => {
    puerto.emitir.mockRejectedValue(
      new BadRequestException('No se puede emitir el documento POS: la sede no tiene resolución'),
    );
    const r: any = await svc.alCobrar(sale, 'pos_anonimo', user);
    expect(r).toBe(sale);
    expect(r.documentoFiscal).toEqual({
      solicitado: 'pos_anonimo',
      estado: 'error',
      error: 'No se puede emitir el documento POS: la sede no tiene resolución',
    });
    expect(puerto.transmitir).not.toHaveBeenCalled();
  });

  it('exclusión POS/FEV (409): la venta queda cobrada y el motivo viaja', async () => {
    puerto.emitir.mockRejectedValue(new ConflictException('Esta venta ya tiene factura electrónica'));
    const r: any = await svc.alCobrar(sale, 'pos_anonimo', user);
    expect(r.documentoFiscal.estado).toBe('error');
    expect(r.documentoFiscal.error).toMatch(/ya tiene factura/);
  });

  it('un error inesperado no filtra detalles internos', async () => {
    puerto.emitir.mockRejectedValue(new Error('MongoServerError: connection reset at 10.0.0.3'));
    const r: any = await svc.alCobrar(sale, 'fev', user);
    expect(r.documentoFiscal.estado).toBe('error');
    expect(r.documentoFiscal.error).not.toMatch(/10\.0\.0\.3/);
  });

  it('si la emisión pasa del plazo, el cobro responde «en proceso» y la emisión termina en segundo plano', async () => {
    let terminar!: (v: typeof emitido) => void;
    puerto.emitir.mockReturnValue(new Promise((res) => (terminar = res)));
    const r: any = await svc.alCobrar(sale, 'pos_identificado', user);
    expect(r.documentoFiscal).toEqual({ solicitado: 'pos_identificado', estado: 'en_proceso' });
    expect(enSegundoPlano).toHaveLength(1);
    terminar(emitido);
    await Promise.all(enSegundoPlano);
    await Promise.all(enSegundoPlano); // la transmisión se encola al terminar
    const ultimo = saleModel.updateOne.mock.calls.at(-1);
    expect(ultimo[1].$set.documentoFiscal).toMatchObject({ estado: 'emitido', documentoId: 'd1' });
    expect(puerto.transmitir).toHaveBeenCalledWith('d1', user);
  });

  /** Modelo que aplica el filtro de `updateOne` como Mongo, sobre una sola venta. */
  const ventaGuardada = (
    inicial: Record<string, unknown> | undefined,
    antesDeEscribir?: (estado: string) => Promise<void>,
  ) => {
    const db: { documentoFiscal?: any } = { documentoFiscal: inicial };
    saleModel.updateOne = vi.fn((filtro: any, upd: any) => ({
      exec: async () => {
        await antesDeEscribir?.(upd.$set.documentoFiscal.estado);
        const cond = filtro['documentoFiscal.estado'];
        const pasa = !cond || db.documentoFiscal?.estado !== cond.$ne;
        if (pasa) db.documentoFiscal = upd.$set.documentoFiscal;
        return { matchedCount: pasa ? 1 : 0 };
      },
    }));
    return db;
  };

  it('el «en_proceso» del plazo no pisa el «emitido» que la emisión tardía ya guardó', async () => {
    let terminar!: (v: typeof emitido) => void;
    puerto.emitir.mockReturnValue(new Promise((res) => (terminar = res)));
    // Vence el plazo; la emisión termina y guarda `emitido` en segundo plano
    // ANTES de que llegue a la base el `en_proceso` del cobro.
    const db = ventaGuardada(undefined, async (estado) => {
      if (estado !== 'en_proceso') return;
      terminar(emitido);
      await Promise.all(enSegundoPlano);
    });
    await svc.alCobrar(sale, 'pos_anonimo', user);
    expect(saleModel.updateOne.mock.calls.map((c: any[]) => c[1].$set.documentoFiscal.estado)).toEqual(
      expect.arrayContaining(['en_proceso', 'emitido']),
    );
    expect(db.documentoFiscal).toMatchObject({ estado: 'emitido', documentoId: 'd1' });
  });

  it('un reintento con el otro documento (409) no pisa el POS ya emitido de la venta', async () => {
    const pos = { solicitado: 'pos_anonimo', estado: 'emitido', documentoId: 'd1', tipo: 'pos' };
    const db = ventaGuardada(pos);
    puerto.emitir.mockRejectedValue(new ConflictException('Esta venta ya tiene documento equivalente POS'));
    const r: any = await svc.alCobrar(sale, 'fev', user);
    // La respuesta dice por qué no salió la FEV; la venta conserva su POS.
    expect(r.documentoFiscal).toMatchObject({ solicitado: 'fev', estado: 'error' });
    expect(db.documentoFiscal).toEqual(pos);
  });

  it('venta offline: no emite y la marca pendiente de contingencia 07', async () => {
    const r: any = await svc.alCobrar(sale, 'pos_anonimo', user, { offline: true });
    expect(puerto.emitir).not.toHaveBeenCalled();
    expect(r.documentoFiscal).toEqual({ solicitado: 'pos_anonimo', estado: 'pendiente_contingencia_07' });
    expect(saleModel.updateOne).toHaveBeenCalled();
  });

  it('reintento del mismo cobro (idempotencia): si ya está emitido no vuelve a llamar al emisor', async () => {
    sale.documentoFiscal = { solicitado: 'pos_anonimo', estado: 'emitido', documentoId: 'd1' };
    const r = await svc.alCobrar(sale, 'pos_anonimo', user);
    expect(r).toBe(sale);
    expect(puerto.emitir).not.toHaveBeenCalled();
  });

  it('sin el módulo de factura electrónica cargado: error claro, la venta sigue', async () => {
    moduleRef.get.mockImplementation(() => {
      throw new Error('Nest could not find EMISION_DOCUMENTO_FISCAL');
    });
    const r: any = await svc.alCobrar(sale, 'pos_anonimo', user);
    expect(r.documentoFiscal.estado).toBe('error');
  });

  it('si guardar el estado en la venta falla, el cobro tampoco se rompe', async () => {
    saleModel.updateOne.mockReturnValue({ exec: async () => Promise.reject(new Error('down')) });
    const r: any = await svc.alCobrar(sale, 'pos_anonimo', user);
    expect(r.documentoFiscal.estado).toBe('emitido');
  });
});
