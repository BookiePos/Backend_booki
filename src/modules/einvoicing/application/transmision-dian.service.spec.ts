import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotImplementedException } from '@nestjs/common';
import { Types } from 'mongoose';

// El servicio importa el esquema: se neutralizan los decoradores (patrón de
// `orders.service.checkout.spec.ts`).
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

import { TransmisionDianService } from './transmision-dian.service';
import {
  ArmadorUblPendiente,
  FirmaNoDisponibleError,
  MENSAJE_BUILDER_PENDIENTE,
} from './transmision-dian.puertos';
import { StubDian } from '../domain/stub-dian';
import type { RespuestaDian, TransmisorDian } from '../domain/transmisor-dian';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Orquestación de la transmisión (Fase 4B) con dobles del modelo, del bucket,
 * del firmante y del transmisor. El modelo falso aplica los filtros de verdad
 * (estado previo y bloqueo), así que la concurrencia se prueba con él.
 */

const NIT = '900123456';
const SEDE = new Types.ObjectId();
const ACEPTADA: RespuestaDian = { ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: ['Procesado'] };
const RECHAZADA: RespuestaDian = {
  ok: false,
  isValid: false,
  origen: 'dian',
  codigo: '99',
  mensajes: ['FAD06: el valor no coincide'],
};
const sinVeredicto = (codigo: string): RespuestaDian => ({ ok: false, origen: 'adapter', codigo, mensajes: [codigo] });

// ── Modelo en memoria que entiende los filtros que usa el servicio ──────────
type Fila = Record<string, any>;

function cumple(fila: Fila, filtro: Record<string, any>): boolean {
  return Object.entries(filtro).every(([k, v]) => {
    if (k === '$or') return (v as Record<string, any>[]).some((f) => cumple(fila, f));
    if (k === '_id') return String(fila._id) === String(v);
    if (v === null) return fila[k] == null;
    if (v && typeof v === 'object' && '$lte' in v) return fila[k] != null && fila[k] <= v.$lte;
    return fila[k] === v;
  });
}

function aplicar(fila: Fila, update: Record<string, any>): void {
  Object.assign(fila, update.$set ?? {});
  for (const [k, n] of Object.entries(update.$inc ?? {})) fila[k] = (fila[k] ?? 0) + (n as number);
  for (const k of Object.keys(update.$unset ?? {})) delete fila[k];
}

function modeloFalso(log: string[]) {
  const filas = new Map<string, Fila>();
  // Copia superficial: `structuredClone` le quita el prototipo al ObjectId.
  const copia = (f: Fila | undefined) => (f ? { ...f } : null);
  const modelo = {
    filas,
    findById: (id: string) => ({ exec: async () => copia(filas.get(String(id))) }),
    findOneAndUpdate: (filtro: Record<string, any>, update: Record<string, any>) => ({
      exec: async () => {
        const fila = [...filas.values()].find((f) => cumple(f, filtro));
        if (!fila) return null;
        aplicar(fila, update);
        if (update.$set?.dianStatus) log.push(`escribe:${update.$set.dianStatus}`);
        return copia(fila);
      },
    }),
    updateOne: (filtro: Record<string, any>, update: Record<string, any>) => ({
      exec: async () => {
        const fila = [...filas.values()].find((f) => cumple(f, filtro));
        if (fila) aplicar(fila, update);
        return { matchedCount: fila ? 1 : 0 };
      },
    }),
  };
  return modelo;
}

describe('TransmisionDianService', () => {
  let log: string[];
  let modelo: ReturnType<typeof modeloFalso>;
  let bucket: Map<string, Buffer>;
  let storage: any;
  let emisores: any;
  let armador: { armar: ReturnType<typeof vi.fn> };
  let firmante: { firmar: ReturnType<typeof vi.fn<(xml: string, emisorId: string) => Promise<string>>> };
  let transmisor: TransmisorDian & { enviar: ReturnType<typeof vi.fn>; consultar: ReturnType<typeof vi.fn> };
  let proveedor: { para: ReturnType<typeof vi.fn> };
  let svc: TransmisionDianService;
  let emisor: Record<string, unknown>;

  const docBase = (cambios: Fila = {}): Fila => ({
    _id: new Types.ObjectId(),
    sedeId: SEDE,
    type: 'invoice',
    prefix: 'SETP',
    number: 990000001,
    fullNumber: 'SETP990000001',
    dianStatus: 'draft',
    tipoAmbiente: '2',
    cufe: 'cufe-1',
    emisor: { nitNorm: NIT },
    resolution: { prefijo: 'SETP', numero: '18760000001' },
    intentos: 0,
    ...cambios,
  });
  const sembrar = (cambios: Fila = {}) => {
    const d = docBase(cambios);
    modelo.filas.set(String(d._id), d);
    return d;
  };
  const fila = (d: Fila) => modelo.filas.get(String(d._id))!;
  const enEmpresa = <T>(fn: () => Promise<T>) =>
    TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, fn);
  const transmitir = (d: Fila, user?: JwtUser) => enEmpresa(() => svc.transmitir(String(d._id), user));

  const construir = (arm: { armar: any } = armador) =>
    new TransmisionDianService(modelo as never, emisores, storage, arm, firmante, proveedor as never);

  beforeEach(() => {
    log = [];
    modelo = modeloFalso(log);
    bucket = new Map();
    storage = {
      guardarArtefacto: vi.fn(async (emisorId: string, docId: string, tipo: string, contenido: Buffer) => {
        const pathname = `einvoicing/b1/${emisorId}/docs/${docId}/documento.${tipo}`;
        bucket.set(pathname, contenido);
        log.push('bucket:guardar');
        return { pathname };
      }),
      leerArtefacto: vi.fn(async (emisorId: string, docId: string, tipo: string) => {
        const b = bucket.get(`einvoicing/b1/${emisorId}/docs/${docId}/documento.${tipo}`);
        if (!b) throw new Error('no existe');
        return b;
      }),
    };
    emisor = { id: 'e1', tipoAmbiente: '2', habilitado: false, nitNorm: NIT };
    emisores = {
      obtenerPorSede: vi.fn(async () => emisor),
      estadoConfiguracion: vi.fn(async () => ({ faltaParaTransmitir: [] })),
    };
    let version = 0;
    armador = { armar: vi.fn(async () => { log.push('armar'); return '<Invoice/>'; }) };
    firmante = {
      firmar: vi.fn(async (xml: string) => {
        log.push('firmar');
        version += 1;
        return `${xml}<!--firma-${version}-->`;
      }),
    };
    transmisor = {
      enviar: vi.fn(async () => { log.push('red:enviar'); return ACEPTADA; }),
      consultar: vi.fn(async () => { log.push('red:consultar'); return ACEPTADA; }),
      enviarSetPruebas: vi.fn(),
      rangos: vi.fn(),
    } as never;
    proveedor = { para: vi.fn(async () => transmisor) };
    svc = construir();
  });

  it('draft → signed → sent → accepted, con XML en el bucket y el número intacto', async () => {
    const d = sembrar();
    const r = await transmitir(d);
    expect(r).toMatchObject({ dianStatus: 'accepted', transmitido: true, intentos: 1 });
    const f = fila(d);
    expect(f.xmlPath).toBe(`einvoicing/b1/e1/docs/${String(d._id)}/documento.xml`);
    expect(f.enviadoAt).toBeInstanceOf(Date);
    expect(f.number).toBe(990000001);
    expect(f.fullNumber).toBe('SETP990000001');
    expect(f.bloqueoTransmision).toBeUndefined();
    expect(f.respuestaDian).toMatchObject({ ok: true, isValid: true, codigo: '00' });
    expect(proveedor.para).toHaveBeenCalledWith(String(SEDE), '2');
    expect(transmisor.enviar).toHaveBeenCalledWith({
      tipo: 'invoice',
      fullNumber: 'SETP990000001',
      cufe: 'cufe-1',
      xmlFirmado: '<Invoice/><!--firma-1-->',
    });
  });

  it('NO REORDENAR: firma y bucket antes de signed, sent persistido antes de la red', async () => {
    const d = sembrar();
    transmisor.enviar.mockImplementation(async () => {
      // En el instante de la llamada de red el documento YA está en `sent`.
      expect(fila(d).dianStatus).toBe('sent');
      expect(fila(d).intentos).toBe(1);
      log.push('red:enviar');
      return ACEPTADA;
    });
    await transmitir(d);
    expect(log).toEqual([
      'armar',
      'firmar',
      'bucket:guardar',
      'escribe:signed',
      'escribe:sent',
      'red:enviar',
      'escribe:accepted',
    ]);
  });

  it('rechazo con veredicto de la DIAN: rejected con motivo y respuesta acotada', async () => {
    transmisor.enviar.mockResolvedValue({ ...RECHAZADA, mensajes: ['FAD06', 'x'.repeat(2000)], extra: 'secreto' });
    const d = sembrar();
    const r = await transmitir(d);
    expect(r.dianStatus).toBe('rejected');
    const f = fila(d);
    expect(f.rechazoMotivo).toContain('FAD06');
    expect(f.respuestaDian).not.toHaveProperty('extra');
    expect(Object.keys(f.respuestaDian).sort()).toEqual(
      ['codigo', 'isValid', 'mensajes', 'ok', 'origen', 'recibidaAt'].sort(),
    );
    expect((f.respuestaDian.mensajes as string[])[1]).toHaveLength(500);
  });

  it.each(['RED', 'PENDIENTE_DIAN', 'NO_RECIBIDO_DIAN'])('sin veredicto (%s) queda en sent', async (codigo) => {
    transmisor.enviar.mockResolvedValue(sinVeredicto(codigo));
    const d = sembrar();
    const r = await transmitir(d);
    expect(r).toMatchObject({ dianStatus: 'sent', transmitido: true, codigo });
    expect(fila(d).rechazoMotivo).toBeUndefined();
  });

  it('IsValid=false con código sin veredicto (PENDIENTE_DIAN de la DIAN) no rechaza', async () => {
    transmisor.enviar.mockResolvedValue({ ok: false, isValid: false, origen: 'dian', codigo: 'PENDIENTE_DIAN', mensajes: [] });
    const d = sembrar();
    expect((await transmitir(d)).dianStatus).toBe('sent');
  });

  it('una excepción del transmisor es RED: queda en sent, sin rechazo', async () => {
    transmisor.enviar.mockRejectedValue(new Error('ETIMEDOUT <xml>secreto</xml>'));
    const d = sembrar();
    const r = await transmitir(d);
    expect(r).toMatchObject({ dianStatus: 'sent', codigo: 'RED' });
    expect(JSON.stringify(fila(d).respuestaDian)).not.toContain('secreto');
  });

  it('respuesta fuera de contrato (ok:true sin veredicto) no acepta', async () => {
    transmisor.enviar.mockResolvedValue({ ok: true, origen: 'adapter', mensajes: [] });
    const d = sembrar();
    expect((await transmitir(d)).dianStatus).toBe('sent');
  });

  it('YA_PROCESADO_DIAN: consulta por CUFE y toma ese veredicto', async () => {
    transmisor.enviar.mockResolvedValue({ ok: false, isValid: false, origen: 'dian', codigo: 'YA_PROCESADO_DIAN', mensajes: [] });
    const d = sembrar();
    const r = await transmitir(d);
    expect(transmisor.consultar).toHaveBeenCalledWith({ cufe: 'cufe-1' });
    expect(r.dianStatus).toBe('accepted');
  });

  it('YA_PROCESADO_DIAN y la consulta falla: queda en sent', async () => {
    transmisor.enviar.mockResolvedValue({ ok: false, isValid: false, origen: 'dian', codigo: 'YA_PROCESADO_DIAN', mensajes: [] });
    transmisor.consultar.mockRejectedValue(new Error('timeout'));
    const d = sembrar();
    expect((await transmitir(d)).dianStatus).toBe('sent');
  });

  it('reintento de un sent: reenvía el MISMO XML del bucket, sin rearmar ni renumerar', async () => {
    transmisor.enviar.mockResolvedValueOnce(sinVeredicto('RED'));
    const d = sembrar();
    await transmitir(d);
    const xmlPrimero = transmisor.enviar.mock.calls[0]![0].xmlFirmado;
    expect(fila(d).dianStatus).toBe('sent');

    const r = await transmitir(d);
    expect(r).toMatchObject({ dianStatus: 'accepted', intentos: 2 });
    expect(armador.armar).toHaveBeenCalledTimes(1);
    expect(firmante.firmar).toHaveBeenCalledTimes(1);
    expect(transmisor.enviar.mock.calls[1]![0].xmlFirmado).toBe(xmlPrimero);
    expect(transmisor.enviar.mock.calls[1]![0].fullNumber).toBe('SETP990000001');
    expect(fila(d).number).toBe(990000001);
  });

  it('signed con XML guardado: reenvía ese XML, no lo vuelve a firmar', async () => {
    const d = docBase({ dianStatus: 'signed' });
    const path = `einvoicing/b1/e1/docs/${String(d._id)}/documento.xml`;
    d.xmlPath = path;
    modelo.filas.set(String(d._id), d);
    bucket.set(path, Buffer.from('<Invoice firmado="si"/>'));
    const r = await transmitir(d);
    expect(r.dianStatus).toBe('accepted');
    expect(armador.armar).not.toHaveBeenCalled();
    expect(firmante.firmar).not.toHaveBeenCalled();
    expect(transmisor.enviar.mock.calls[0]![0].xmlFirmado).toBe('<Invoice firmado="si"/>');
  });

  it('sent sin XML guardado: no rearma ni transmite (revisión manual)', async () => {
    const d = sembrar({ dianStatus: 'sent' });
    await expect(transmitir(d)).rejects.toBeInstanceOf(ConflictException);
    expect(armador.armar).not.toHaveBeenCalled();
    expect(transmisor.enviar).not.toHaveBeenCalled();
    expect(fila(d).bloqueoTransmision).toBeUndefined();
  });

  it('rejected corregido: se vuelve a firmar con el MISMO número (rejected → signed)', async () => {
    transmisor.enviar.mockResolvedValueOnce(RECHAZADA);
    const d = sembrar();
    await transmitir(d);
    expect(fila(d).dianStatus).toBe('rejected');
    log.length = 0;

    const r = await transmitir(d);
    expect(r.dianStatus).toBe('accepted');
    expect(log).toEqual(['armar', 'firmar', 'bucket:guardar', 'escribe:signed', 'escribe:sent', 'red:enviar', 'escribe:accepted']);
    expect(transmisor.enviar.mock.calls[1]![0].xmlFirmado).toBe('<Invoice/><!--firma-2-->');
    expect(transmisor.enviar.mock.calls.map((c) => c[0].fullNumber)).toEqual(['SETP990000001', 'SETP990000001']);
    expect(fila(d).number).toBe(990000001);
    expect(fila(d).rechazoMotivo).toBeUndefined();
  });

  it('concurrencia: dos llamadas a la vez transmiten una sola vez', async () => {
    const d = sembrar();
    const [a, b] = await Promise.all([transmitir(d), transmitir(d)]);
    expect(transmisor.enviar).toHaveBeenCalledTimes(1);
    expect(firmante.firmar).toHaveBeenCalledTimes(1);
    expect([a.codigo, b.codigo]).toContain('EN_CURSO');
    expect(fila(d).dianStatus).toBe('accepted');
    expect(fila(d).intentos).toBe(1);
  });

  it('bloqueo vigente de otro: no transmite; vencido: lo toma', async () => {
    const d = sembrar({ bloqueoTransmision: 'otro', bloqueoHasta: new Date(Date.now() + 60_000) });
    expect((await transmitir(d)).codigo).toBe('EN_CURSO');
    expect(transmisor.enviar).not.toHaveBeenCalled();
    fila(d).bloqueoHasta = new Date(Date.now() - 1);
    expect((await transmitir(d)).dianStatus).toBe('accepted');
  });

  it('gate: CONFIG_FALTANTE sin firmar ni salir a la red (producción sin habilitar)', async () => {
    emisor = { ...emisor, tipoAmbiente: '1', habilitado: false };
    const d = sembrar({ tipoAmbiente: '1', resolution: { prefijo: 'FE', numero: '187640' } });
    const r = await transmitir(d);
    expect(r).toMatchObject({ dianStatus: 'draft', transmitido: false, codigo: 'CONFIG_FALTANTE' });
    expect(r.mensajes).toContain('el emisor no está habilitado para producción');
    expect(proveedor.para).not.toHaveBeenCalled();
    expect(armador.armar).not.toHaveBeenCalled();
    expect(transmisor.enviar).not.toHaveBeenCalled();
    expect(fila(d).respuestaDian).toMatchObject({ codigo: 'CONFIG_FALTANTE', origen: 'adapter' });
  });

  it('gate: un documento de pruebas no va a producción', async () => {
    emisor = { ...emisor, tipoAmbiente: '1', habilitado: true };
    const d = sembrar();
    const r = await transmitir(d);
    expect(r.codigo).toBe('CONFIG_FALTANTE');
    expect(transmisor.enviar).not.toHaveBeenCalled();
  });

  it('sin emisor: CONFIG_FALTANTE sin red', async () => {
    emisores.obtenerPorSede.mockResolvedValue(null);
    const d = sembrar();
    expect((await transmitir(d)).codigo).toBe('CONFIG_FALTANTE');
    expect(transmisor.enviar).not.toHaveBeenCalled();
  });

  it('transmisor stub: CONFIG_FALTANTE, ni firma ni sent', async () => {
    proveedor.para.mockResolvedValue(new StubDian('Transmisión directa a la DIAN aún no implementada'));
    const d = sembrar();
    const r = await transmitir(d);
    expect(r).toMatchObject({ dianStatus: 'draft', codigo: 'CONFIG_FALTANTE', transmitido: false });
    expect(armador.armar).not.toHaveBeenCalled();
    expect(fila(d).dianStatus).toBe('draft');
    expect(fila(d).intentos).toBe(0);
  });

  it('builder UBL pendiente: lanza y el documento queda en draft sin consumir nada', async () => {
    svc = construir(new ArmadorUblPendiente());
    const d = sembrar();
    await expect(transmitir(d)).rejects.toThrow(NotImplementedException);
    await expect(transmitir(d)).rejects.toThrow(MENSAJE_BUILDER_PENDIENTE);
    const f = fila(d);
    expect(f.dianStatus).toBe('draft');
    expect(f.intentos).toBe(0);
    expect(f.bloqueoTransmision).toBeUndefined();
    expect(firmante.firmar).not.toHaveBeenCalled();
    expect(storage.guardarArtefacto).not.toHaveBeenCalled();
    expect(transmisor.enviar).not.toHaveBeenCalled();
  });

  it('sin certificado para firmar: CONFIG_FALTANTE y queda en draft', async () => {
    firmante.firmar.mockRejectedValue(new FirmaNoDisponibleError());
    const d = sembrar();
    const r = await transmitir(d);
    expect(r).toMatchObject({ dianStatus: 'draft', codigo: 'CONFIG_FALTANTE' });
    expect(storage.guardarArtefacto).not.toHaveBeenCalled();
    expect(transmisor.enviar).not.toHaveBeenCalled();
    expect(fila(d).bloqueoTransmision).toBeUndefined();
  });

  it('accepted: no hace nada', async () => {
    const d = sembrar({ dianStatus: 'accepted' });
    const r = await transmitir(d);
    expect(r).toMatchObject({ dianStatus: 'accepted', transmitido: false });
    expect(proveedor.para).not.toHaveBeenCalled();
  });

  it('sin TenantContext no lee nada', async () => {
    const d = sembrar();
    await expect(svc.transmitir(String(d._id))).rejects.toThrow(/contexto de empresa/);
  });

  it('usuario sin acceso a la sede del documento: 403', async () => {
    const d = sembrar();
    const user = { email: 'c@b.co', role: 'cashier', permissions: [], sedeIds: [new Types.ObjectId().toString()] } as unknown as JwtUser;
    await expect(transmitir(d, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(transmisor.enviar).not.toHaveBeenCalled();
  });
});
