import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { TransmisionDianService } from './transmision-dian.service';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import type { RespuestaDian, TransmisorDian } from '../domain/transmisor-dian';
import { admiteContingenciaDian, tipoContingencia } from '../domain/contingencia';
import { CODIGOS_SIN_VEREDICTO, estadoTrasRespuesta } from '../domain/estado-dian';
import { enColaDeReenvio, salioDeLaCola } from '../domain/reconsulta';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Fase 9: las notas crédito y débito NO tienen contingencia (ni 03 ni 04). Si
 * la DIAN no responde quedan firmadas y en cola; el cron de reconsulta reenvía
 * el MISMO XML, sin renumerar ni volver a firmar, hasta que haya veredicto.
 * Transporte falso: nada sale a la DIAN.
 */
const NIT = '900123456';
const SEDE = new Types.ObjectId();
const ACEPTADA: RespuestaDian = { ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: ['Procesado'] };
const RED: RespuestaDian = { ok: false, origen: 'adapter', codigo: 'RED', mensajes: ['caída'] };
const YA_PROCESADO: RespuestaDian = {
  ok: false,
  isValid: false,
  origen: 'dian',
  codigo: 'YA_PROCESADO_DIAN',
  mensajes: ['Regla 90'],
};
const ONCE_MIN = 11 * 60_000;

type Fila = Record<string, any>;

const valor = (fila: Fila, k: string): any =>
  k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), fila as any);
function cumple(fila: Fila, filtro: Record<string, any>): boolean {
  return Object.entries(filtro).every(([k, v]) => {
    if (k === '$or') return (v as Record<string, any>[]).some((f) => cumple(fila, f));
    if (k === '$and') return (v as Record<string, any>[]).every((f) => cumple(fila, f));
    if (k === '_id') return String(fila._id) === String(v);
    const x = valor(fila, k);
    if (v === null) return x == null;
    if (v instanceof Types.ObjectId) return String(x) === String(v);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$lte' in v) return x != null && x <= v.$lte;
      if ('$gt' in v) return x != null && x > v.$gt;
      if ('$in' in v) return (v.$in as unknown[]).includes(x);
      if ('$ne' in v) return x !== v.$ne;
      if ('$exists' in v) return (x !== undefined) === v.$exists;
    }
    return x === v;
  });
}
function aplicar(fila: Fila, update: Record<string, any>): void {
  Object.assign(fila, update.$set ?? {});
  for (const [k, n] of Object.entries(update.$inc ?? {})) fila[k] = (fila[k] ?? 0) + (n as number);
  for (const k of Object.keys(update.$unset ?? {})) delete fila[k];
}
const consulta = <T>(fn: () => T) => {
  const q: any = { exec: async () => fn(), lean: () => q, select: () => q, sort: () => q, limit: () => q };
  return q;
};

function modeloFalso() {
  const filas = new Map<string, Fila>();
  const copia = (f: Fila | undefined) => (f ? { ...f } : null);
  const buscar = (filtro: Record<string, any>) => [...filas.values()].filter((f) => cumple(f, filtro));
  return {
    filas,
    findById: (id: string) => ({ exec: async () => copia(filas.get(String(id))) }),
    findOne: (filtro: Record<string, any>) => consulta(() => copia(buscar(filtro)[0])),
    find: (filtro: Record<string, any>) => consulta(() => buscar(filtro).map((f) => copia(f))),
    countDocuments: (filtro: Record<string, any>) => consulta(() => buscar(filtro).length),
    findOneAndUpdate: (filtro: Record<string, any>, update: Record<string, any>) => ({
      exec: async () => {
        const fila = buscar(filtro)[0];
        if (!fila) return null;
        aplicar(fila, update);
        return copia(fila);
      },
    }),
    updateOne: (filtro: Record<string, any>, update: Record<string, any>) => ({
      exec: async () => {
        const fila = buscar(filtro)[0];
        if (fila) aplicar(fila, update);
        return { matchedCount: fila ? 1 : 0 };
      },
    }),
  };
}

describe('Notas sin contingencia: cola y reenvío del mismo XML (Fase 9)', () => {
  let modelo: ReturnType<typeof modeloFalso>;
  let bucket: Map<string, Buffer>;
  let armador: { armar: ReturnType<typeof vi.fn> };
  let firmante: { firmar: ReturnType<typeof vi.fn> };
  let transmisor: TransmisorDian & { enviar: ReturnType<typeof vi.fn>; consultar: ReturnType<typeof vi.fn> };
  let emisor: Fila;
  let svc: TransmisionDianService;
  let esperas: number[];

  const sembrar = (cambios: Fila = {}): Fila => {
    const d: Fila = {
      _id: new Types.ObjectId(),
      sedeId: SEDE,
      type: 'credit_note',
      prefix: 'NC',
      number: 7,
      fullNumber: 'NC7',
      issueDate: '2026-11-10',
      dianStatus: 'draft',
      // Producción: el único ambiente donde una factura SÍ declararía la 04.
      tipoAmbiente: '1',
      cufe: 'cude-nota-7',
      emisor: { nitNorm: NIT },
      resolution: { prefijo: 'NC', numero: '18764000999' },
      intentos: 0,
      ...cambios,
    };
    modelo.filas.set(String(d._id), d);
    return d;
  };
  const fila = (d: Fila) => modelo.filas.get(String(d._id))!;
  const ruta = (d: Fila) => `einvoicing/b1/e1/docs/${String(d._id)}/documento.xml`;
  const xmlGuardado = (d: Fila) => bucket.get(ruta(d))!.toString('utf8');
  const xmlEnviado = (i: number) => (transmisor.enviar.mock.calls[i]![0] as Fila).xmlFirmado as string;
  const enEmpresa = <T>(fn: () => Promise<T>) => TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, fn);
  const DUENO = {
    userId: 'u1',
    email: 'd@b.co',
    name: 'Dueña',
    role: 'owner',
    permissions: [],
    sedeIds: [],
  } as unknown as JwtUser;
  const transmitir = (d: Fila) => enEmpresa(() => svc.transmitir(String(d._id), DUENO));
  /** Una corrida del cron, N minutos después (el reposo es de 10 min). */
  const cron = (minutosDespues = 11) =>
    enEmpresa(() => svc.reconsultarPendientes(10, { ahora: new Date(Date.now() + minutosDespues * 60_000) }));

  beforeEach(() => {
    esperas = [];
    modelo = modeloFalso();
    bucket = new Map();
    const storage = new EinvoicingStorageService({
      uploadPrivado: async (pathname: string, contenido: Buffer) => {
        bucket.set(pathname, contenido);
        return { pathname };
      },
      descargarPrivado: async (pathname: string) => {
        const buffer = bucket.get(pathname);
        if (!buffer) throw new Error('no existe');
        return { buffer };
      },
    } as never);
    emisor = { id: 'e1', tipoAmbiente: '1', habilitado: true, nitNorm: NIT };
    const emisores = {
      obtenerPorSede: vi.fn(async () => emisor),
      estadoConfiguracion: vi.fn(async () => ({ faltaParaTransmitir: [] })),
    };
    armador = {
      armar: vi.fn(
        async (doc: Fila) => `<Nota n="${String(doc.fullNumber)}" cont="${String(doc.contingencia?.tipo ?? '')}"/>`,
      ),
    };
    let version = 0;
    firmante = { firmar: vi.fn(async (xml: string) => `${xml}<!--firma-${++version}-->`) };
    transmisor = {
      enviar: vi.fn(async () => ACEPTADA),
      consultar: vi.fn(async () => ACEPTADA),
      enviarSetPruebas: vi.fn(),
      rangos: vi.fn(),
    } as never;
    const proveedor = { para: vi.fn(async () => transmisor) };
    svc = new TransmisionDianService(
      modelo as never,
      emisores as never,
      storage,
      armador as never,
      firmante as never,
      proveedor as never,
      { record: vi.fn(async () => undefined) } as never,
    );
    svc.esperar = async (ms) => {
      esperas.push(ms);
    };
  });

  for (const tipo of ['credit_note', 'debit_note'] as const) {
    it(`${tipo}: RED → queda en vuelo, firmada → el cron reenvía el MISMO XML → aceptada`, async () => {
      transmisor.enviar.mockResolvedValueOnce(RED);
      const d = sembrar({ type: tipo });
      const r = await transmitir(d);

      // En vuelo, sin veredicto y SIN contingencia: un solo envío (los tres
      // intentos con 5 s son de la 04/08), una sola firma, el mismo número.
      expect(r).toMatchObject({
        dianStatus: 'sent',
        codigo: 'RED',
        transmitido: true,
        fullNumber: 'NC7',
        intentos: 1,
      });
      expect(transmisor.enviar).toHaveBeenCalledTimes(1);
      expect(esperas).toEqual([]);
      expect(fila(d).contingencia).toBeUndefined();
      expect(fila(d).rechazoMotivo).toBeUndefined();
      expect(enColaDeReenvio(fila(d))).toBe(true);
      const firmado = xmlGuardado(d);

      // Antes del reposo de 10 min el cron no la toca.
      expect(await cron(5)).toMatchObject({ revisados: 0 });

      const c = await cron();
      expect(c).toEqual({ revisados: 1, avanzados: 1, omitidos: 0, errores: 0 });
      expect(fila(d)).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NC7', number: 7, intentos: 2 });
      expect(xmlEnviado(0)).toBe(firmado);
      expect(xmlEnviado(1)).toBe(firmado);
      expect(xmlGuardado(d)).toBe(firmado);
      expect(firmante.firmar).toHaveBeenCalledTimes(1);
      expect(armador.armar).toHaveBeenCalledTimes(1);
      expect(fila(d).contingencia).toBeUndefined();
    });
  }

  it('la DIAN sigue caída corrida tras corrida: nunca pasa a contingencia, ni se refirma, ni se renumera (sin tope)', async () => {
    transmisor.enviar.mockResolvedValue(RED);
    const d = sembrar();
    await transmitir(d);
    const firmado = xmlGuardado(d);
    for (let i = 0; i < 6; i++) {
      // Cada corrida deja `enviadoAt` en «ahora»: la siguiente llega 11 min después.
      fila(d).enviadoAt = new Date(Date.now() - ONCE_MIN);
      const c = await enEmpresa(() => svc.reconsultarPendientes(10));
      expect(c).toMatchObject({ revisados: 1, avanzados: 0, errores: 0 });
      expect(fila(d).dianStatus).toBe('sent');
    }
    // 1 + 6 envíos: uno por corrida, jamás los tres seguidos de la 04/08.
    expect(transmisor.enviar).toHaveBeenCalledTimes(7);
    expect(fila(d)).toMatchObject({ intentos: 7, fullNumber: 'NC7', number: 7 });
    expect(fila(d).contingencia).toBeUndefined();
    expect(esperas).toEqual([]);
    expect(firmante.firmar).toHaveBeenCalledTimes(1);
    expect(armador.armar.mock.calls.every(([doc]) => !(doc as Fila).contingencia)).toBe(true);
    for (let i = 0; i < 7; i++) expect(xmlEnviado(i)).toBe(firmado);
    // La cola de contingencia (04/08 y 03/07) no la ve: no es de contingencia.
    expect(await enEmpresa(() => svc.transmitirContingencias(10))).toMatchObject({ revisados: 0 });

    // Vuelve el servicio: sale el mismo XML y queda aceptada.
    transmisor.enviar.mockResolvedValue(ACEPTADA);
    fila(d).enviadoAt = new Date(Date.now() - ONCE_MIN);
    expect(await enEmpresa(() => svc.reconsultarPendientes(10))).toMatchObject({ avanzados: 1 });
    expect(fila(d).dianStatus).toBe('accepted');
    expect(xmlEnviado(7)).toBe(firmado);
  });

  it('una excepción o un timeout del transporte también es cola, no rechazo', async () => {
    transmisor.enviar.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const d = sembrar();
    const r = await transmitir(d);
    expect(r).toMatchObject({ dianStatus: 'sent', codigo: 'RED' });
    expect(fila(d).contingencia).toBeUndefined();
    expect(await cron()).toMatchObject({ revisados: 1, avanzados: 1 });
    expect(fila(d).dianStatus).toBe('accepted');
  });

  it('YA_PROCESADO en el reenvío (el primero sí había llegado): consulta GetStatus por CUDE y toma ese veredicto', async () => {
    transmisor.enviar.mockResolvedValueOnce(RED).mockResolvedValueOnce(YA_PROCESADO);
    const d = sembrar();
    await transmitir(d);
    expect(transmisor.consultar).not.toHaveBeenCalled();
    const c = await cron();
    expect(transmisor.consultar).toHaveBeenCalledTimes(1);
    expect(transmisor.consultar).toHaveBeenCalledWith(expect.objectContaining({ cufe: 'cude-nota-7' }));
    expect(c).toMatchObject({ revisados: 1, avanzados: 1 });
    expect(fila(d)).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NC7' });
    expect(fila(d).rechazoMotivo).toBeUndefined();
    expect(firmante.firmar).toHaveBeenCalledTimes(1);
  });

  it('YA_PROCESADO y GetStatus sin respuesta: sigue en cola, nunca rechazada', async () => {
    transmisor.enviar.mockResolvedValueOnce(RED).mockResolvedValueOnce(YA_PROCESADO);
    transmisor.consultar.mockResolvedValueOnce(RED);
    const d = sembrar();
    await transmitir(d);
    expect(await cron()).toMatchObject({ revisados: 1, avanzados: 0 });
    expect(fila(d).dianStatus).toBe('sent');
    expect(fila(d).rechazoMotivo).toBeUndefined();
  });

  describe('firmada que no llegó a salir (signed con XML)', () => {
    const XML = '<Nota n="NC7"/><!--firma-original-->';
    const firmadaSinSalir = (cambios: Fila = {}) => {
      const d = sembrar({ dianStatus: 'signed', updatedAt: new Date(Date.now() - ONCE_MIN), ...cambios });
      bucket.set(ruta(d), Buffer.from(XML));
      fila(d).xmlPath = ruta(d);
      return d;
    };

    it('el cron la envía con el XML guardado, sin volver a armar ni a firmar', async () => {
      const d = firmadaSinSalir({ type: 'debit_note' });
      const c = await enEmpresa(() => svc.reconsultarPendientes(10));
      expect(c).toEqual({ revisados: 1, avanzados: 1, omitidos: 0, errores: 0 });
      expect(fila(d).dianStatus).toBe('accepted');
      expect(xmlEnviado(0)).toBe(XML);
      expect(armador.armar).not.toHaveBeenCalled();
      expect(firmante.firmar).not.toHaveBeenCalled();
    });

    it('si no puede salir (gate de ambiente) sigue firmada y no cuenta como avance', async () => {
      emisor.habilitado = false;
      const d = firmadaSinSalir();
      const c = await enEmpresa(() => svc.reconsultarPendientes(10));
      expect(c).toEqual({ revisados: 1, avanzados: 0, omitidos: 0, errores: 0 });
      expect(fila(d).dianStatus).toBe('signed');
      expect(transmisor.enviar).not.toHaveBeenCalled();
    });

    it('no toca la recién firmada, la bloqueada por otro proceso, un borrador ni una factura o POS firmados', async () => {
      firmadaSinSalir({ updatedAt: new Date() });
      firmadaSinSalir({ bloqueoTransmision: 'otro', bloqueoHasta: new Date(Date.now() + 60_000) });
      sembrar({ dianStatus: 'draft', updatedAt: new Date(Date.now() - ONCE_MIN) });
      firmadaSinSalir({ type: 'invoice', prefix: 'FE', fullNumber: 'FE1' });
      firmadaSinSalir({ type: 'pos', prefix: 'EPOS', fullNumber: 'EPOS1' });
      expect(await enEmpresa(() => svc.reconsultarPendientes(10))).toMatchObject({ revisados: 0 });
      expect(transmisor.enviar).not.toHaveBeenCalled();
    });
  });

  describe('dominio: quién admite contingencia', () => {
    const SIN_CONTINGENCIA = ['credit_note', 'debit_note', 'payroll', 'payroll_adjustment'];

    it('notas y nómina no tienen tipo 03/04/07/08 ni admiten la de la DIAN, ni en producción', () => {
      for (const type of SIN_CONTINGENCIA) {
        expect(tipoContingencia(type, 'dian')).toBeNull();
        expect(tipoContingencia(type, 'facturador')).toBeNull();
        expect(admiteContingenciaDian({ type, tipoAmbiente: '1' })).toBe(false);
      }
      expect(admiteContingenciaDian({ type: 'invoice', tipoAmbiente: '1' })).toBe(true);
    });

    it('ningún código sin veredicto saca de la cola a un documento en vuelo', () => {
      for (const codigo of CODIGOS_SIN_VEREDICTO) {
        const r: RespuestaDian = { ok: false, origen: 'adapter', codigo, mensajes: [] };
        expect(estadoTrasRespuesta('sent', r)).toBe('sent');
        expect(salioDeLaCola(estadoTrasRespuesta('sent', r))).toBe(false);
      }
    });

    it('enColaDeReenvio: enviado, o firmado con XML; no un borrador ni un veredicto', () => {
      expect(enColaDeReenvio({ dianStatus: 'sent' })).toBe(true);
      expect(enColaDeReenvio({ dianStatus: 'signed', xmlPath: 'x' })).toBe(true);
      expect(enColaDeReenvio({ dianStatus: 'signed' })).toBe(false);
      for (const dianStatus of ['draft', 'accepted', 'rejected', 'contingency']) {
        expect(enColaDeReenvio({ dianStatus, xmlPath: 'x' })).toBe(false);
      }
    });
  });
});
