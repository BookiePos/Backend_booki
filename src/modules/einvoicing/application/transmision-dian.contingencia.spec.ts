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

import { CODIGO_ESPERA_REFERIDO, TransmisionDianService } from './transmision-dian.service';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import type { RespuestaDian, TransmisorDian } from '../domain/transmisor-dian';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Contingencia en la transmisión (Fase 9): reintentos y declaración de la
 * 04/08, cola de contingencia con el plazo que arranca al volver la DIAN, y
 * notas que esperan a su documento y salen en orden (hallazgo (d) de la 6B).
 */
const NIT = '900123456';
const SEDE = new Types.ObjectId();
const ACEPTADA: RespuestaDian = { ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: ['Procesado'] };
const SIN_RESPUESTA: RespuestaDian = { ok: false, origen: 'adapter', codigo: 'RED', mensajes: ['caída'] };

type Fila = Record<string, any>;

function valor(fila: Fila, k: string): any {
  return k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), fila as any);
}
function cumple(fila: Fila, filtro: Record<string, any>): boolean {
  return Object.entries(filtro).every(([k, v]) => {
    if (k === '$or') return (v as Record<string, any>[]).some((f) => cumple(fila, f));
    const x = k === '_id' ? String(fila._id) : valor(fila, k);
    if (k === '_id') return x === String(v);
    if (v === null) return x == null;
    if (v instanceof Types.ObjectId) return String(x) === String(v);
    if (v && typeof v === 'object') {
      if ('$lte' in v) return x != null && x <= v.$lte;
      if ('$in' in v) return (v.$in as unknown[]).includes(x);
      if ('$ne' in v) return x !== v.$ne;
      if ('$exists' in v) return (x !== undefined) === v.$exists;
    }
    return x === v;
  });
}
function aplicar(fila: Fila, update: Record<string, any>): void {
  for (const [k, v] of Object.entries(update.$set ?? {})) {
    const partes = k.split('.');
    let o = fila;
    for (const p of partes.slice(0, -1)) o = o[p] ??= {};
    o[partes[partes.length - 1] as string] = v;
  }
  for (const [k, n] of Object.entries(update.$inc ?? {})) {
    const partes = k.split('.');
    let o = fila;
    for (const p of partes.slice(0, -1)) o = o[p] ??= {};
    const hoja = partes[partes.length - 1] as string;
    o[hoja] = (o[hoja] ?? 0) + (n as number);
  }
  for (const k of Object.keys(update.$unset ?? {})) delete fila[k];
}
const consulta = <T>(valorFn: () => T) => {
  const q: any = { exec: async () => valorFn(), lean: () => q, select: () => q, sort: () => q, limit: () => q };
  return q;
};

function modeloFalso(log: string[]) {
  const filas = new Map<string, Fila>();
  const copia = (f: Fila | undefined) => (f ? { ...f, contingencia: f.contingencia ? { ...f.contingencia } : undefined } : null);
  const buscar = (filtro: Record<string, any>) => [...filas.values()].filter((f) => cumple(f, filtro));
  return {
    filas,
    findById: (id: string) => ({ exec: async () => copia(filas.get(String(id))) }),
    findOne: (filtro: Record<string, any>) => consulta(() => copia(buscar(filtro)[0])),
    find: (filtro: Record<string, any>) =>
      consulta(() => buscar(filtro).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).map((f) => copia(f))),
    countDocuments: (filtro: Record<string, any>) => consulta(() => buscar(filtro).length),
    findOneAndUpdate: (filtro: Record<string, any>, update: Record<string, any>) => ({
      exec: async () => {
        const fila = buscar(filtro)[0];
        if (!fila) return null;
        aplicar(fila, update);
        if (update.$set?.dianStatus) log.push(`escribe:${String(fila.fullNumber)}:${update.$set.dianStatus}`);
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

describe('TransmisionDianService · contingencia (Fase 9)', () => {
  let log: string[];
  let modelo: ReturnType<typeof modeloFalso>;
  let bucket: Map<string, Buffer>;
  let armador: { armar: ReturnType<typeof vi.fn> };
  let transmisor: TransmisorDian & { enviar: ReturnType<typeof vi.fn>; consultar: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let svc: TransmisionDianService;
  let esperas: number[];
  let reloj = 0;

  const sembrar = (cambios: Fila = {}): Fila => {
    const d: Fila = {
      _id: new Types.ObjectId(),
      sedeId: SEDE,
      type: 'pos',
      prefix: 'EPOS',
      number: 1,
      fullNumber: 'EPOS1',
      issueDate: '2026-11-05',
      dianStatus: 'draft',
      tipoAmbiente: '1',
      cufe: 'cude-1',
      emisor: { nitNorm: NIT },
      resolution: { prefijo: 'EPOS', numero: '18764000123' },
      intentos: 0,
      createdAt: ++reloj,
      ...cambios,
    };
    modelo.filas.set(String(d._id), d);
    return d;
  };
  const fila = (d: Fila) => modelo.filas.get(String(d._id))!;
  const enEmpresa = <T>(fn: () => Promise<T>) => TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, fn);
  const DUENO = { userId: 'u1', email: 'd@b.co', name: 'Dueña', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;

  beforeEach(() => {
    log = [];
    esperas = [];
    modelo = modeloFalso(log);
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
    audit = { record: vi.fn(async () => undefined) };
    const emisores = {
      obtenerPorSede: vi.fn(async () => ({ id: 'e1', tipoAmbiente: '1', habilitado: true, nitNorm: NIT })),
      estadoConfiguracion: vi.fn(async () => ({ faltaParaTransmitir: [] })),
    };
    armador = {
      armar: vi.fn(async (doc: Fila) => {
        const tipo = doc.contingencia?.tipo ?? 'normal';
        log.push(`armar:${tipo}`);
        return `<Invoice tipo="${tipo}"/>`;
      }),
    };
    const firmante = { firmar: vi.fn(async (xml: string) => `${xml}<!--firma-->`) };
    transmisor = {
      enviar: vi.fn(async (e: { fullNumber: string; xmlFirmado: string }) => {
        log.push(`red:${e.fullNumber}:${e.xmlFirmado.includes('"08"') ? '08' : e.xmlFirmado.includes('"04"') ? '04' : 'normal'}`);
        return ACEPTADA;
      }),
      consultar: vi.fn(async () => ACEPTADA),
      enviarSetPruebas: vi.fn(),
      rangos: vi.fn(),
    } as never;
    const proveedor = { para: vi.fn(async () => transmisor) };
    svc = new TransmisionDianService(modelo as never, emisores as never, storage, armador as never, firmante as never, proveedor as never, audit as never);
    svc.esperar = async (ms) => {
      esperas.push(ms);
    };
  });

  describe('declaración 04/08 (la DIAN no responde)', () => {
    it('POS en producción: tres envíos con 5 s, se refirma con 08 y el mismo número, y queda en la cola', async () => {
      transmisor.enviar.mockResolvedValue(SIN_RESPUESTA);
      const d = sembrar();
      const r = await enEmpresa(() => svc.transmitir(String(d._id), DUENO));
      expect(transmisor.enviar).toHaveBeenCalledTimes(3);
      expect(esperas).toEqual([5_000, 5_000]);
      expect(r).toMatchObject({ dianStatus: 'contingency', codigo: 'CONTINGENCIA_DIAN', fullNumber: 'EPOS1' });
      const f = fila(d);
      expect(f.contingencia).toMatchObject({ tipo: '08', intentos: 3, referencia: { id: 'EPOS1', fecha: '2026-11-05' } });
      expect(f.cufe).toBe('cude-1');
      expect(f.number).toBe(1);
      expect(bucket.get(f.xmlPath)!.toString()).toContain('tipo="08"');
      expect(f.bloqueoTransmision).toBeUndefined();
    });

    it('factura: 04 sin referencia', async () => {
      transmisor.enviar.mockResolvedValue(SIN_RESPUESTA);
      const d = sembrar({ type: 'invoice', fullNumber: 'FE1', prefix: 'FE' });
      await enEmpresa(() => svc.transmitir(String(d._id), DUENO));
      expect(fila(d).contingencia.tipo).toBe('04');
      expect(fila(d).contingencia.referencia).toBeUndefined();
    });

    it('si responde al segundo intento, no hay contingencia', async () => {
      transmisor.enviar.mockResolvedValueOnce(SIN_RESPUESTA).mockResolvedValueOnce(ACEPTADA);
      const d = sembrar();
      const r = await enEmpresa(() => svc.transmitir(String(d._id), DUENO));
      expect(r.dianStatus).toBe('accepted');
      expect(fila(d).contingencia).toBeUndefined();
    });

    it('un veredicto (rechazo) nunca es contingencia ni se reintenta', async () => {
      transmisor.enviar.mockResolvedValue({ ok: false, isValid: false, origen: 'dian', codigo: '99', mensajes: ['x'] });
      const d = sembrar();
      const r = await enEmpresa(() => svc.transmitir(String(d._id), DUENO));
      expect(transmisor.enviar).toHaveBeenCalledTimes(1);
      expect(r.dianStatus).toBe('rejected');
    });

    it('un reenvío cuando la DIAN ya respondió alguna vez no declara contingencia: queda en vuelo, sin reintentos', async () => {
      transmisor.enviar.mockResolvedValue(SIN_RESPUESTA);
      // 1 intento previo y 0 sin respuesta: la DIAN contestó (p. ej. «pendiente»).
      const reenvio = sembrar({ fullNumber: 'EPOS2', intentos: 1, enviosSinRespuesta: 0 });
      await enEmpresa(() => svc.transmitir(String(reenvio._id), DUENO));
      expect(fila(reenvio).dianStatus).toBe('sent');
      expect(fila(reenvio).contingencia).toBeUndefined();
      expect(esperas).toEqual([]);
    });

    it('reenvío del cron cuando TODOS los envíos previos fueron sin respuesta: sí declara (punto 7)', async () => {
      transmisor.enviar.mockResolvedValue(SIN_RESPUESTA);
      const ruta = (d: Fila) => `einvoicing/b1/e1/docs/${String(d._id)}/documento.xml`;
      const d = sembrar({ fullNumber: 'EPOS3', dianStatus: 'sent', intentos: 2, enviosSinRespuesta: 2 });
      bucket.set(ruta(d), Buffer.from('<Invoice tipo="normal"/><!--firma-->'));
      fila(d).xmlPath = ruta(d);
      const r = await enEmpresa(() => svc.transmitir(String(d._id), DUENO));
      expect(r.dianStatus).toBe('contingency');
      expect(transmisor.enviar).toHaveBeenCalledTimes(3);
    });

    it('cada transmisión sin respuesta suma enviosSinRespuesta (habilitación: queda en vuelo)', async () => {
      transmisor.enviar.mockResolvedValue(SIN_RESPUESTA);
      const d = sembrar({ fullNumber: 'EPOS4', intentos: 0, contingencia: { tipo: '07', declaradaAt: new Date() } });
      await enEmpresa(() => svc.transmitir(String(d._id), DUENO));
      expect(fila(d)).toMatchObject({ dianStatus: 'sent', intentos: 1, enviosSinRespuesta: 1 });
    });

    it('conserva el XML original aparte y la 04 entrega al adquiriente al declararse (punto 4)', async () => {
      const entrega = { entregar: vi.fn(), entregarContingencia: vi.fn(async () => ({ estado: 'contingencia' })) };
      const conEntrega = new TransmisionDianService(
        modelo as never,
        (svc as any).emisores,
        (svc as any).storage,
        armador as never,
        (svc as any).firmante,
        (svc as any).transmisores,
        audit as never,
        entrega as never,
      );
      conEntrega.esperar = async () => undefined;
      transmisor.enviar.mockResolvedValue(SIN_RESPUESTA);
      const d = sembrar({ type: 'invoice', fullNumber: 'FE9', prefix: 'FE' });
      await enEmpresa(() => conEntrega.transmitir(String(d._id), DUENO));
      const f = fila(d);
      expect(f.contingencia.xmlOriginalPath).toBe(`einvoicing/b1/e1/docs/${String(d._id)}/original.xml`);
      expect(bucket.get(f.contingencia.xmlOriginalPath)!.toString()).toContain('tipo="normal"');
      expect(bucket.get(f.xmlPath)!.toString()).toContain('tipo="04"');
      expect(entrega.entregarContingencia).toHaveBeenCalledTimes(1);
      expect((entrega.entregarContingencia.mock.calls as unknown as unknown[][])[0]![0]).toMatchObject({ dianStatus: 'contingency' });
      expect(entrega.entregar).not.toHaveBeenCalled();
    });

    it('si la refirma falla, NO hay contingencia: queda en vuelo con el XML original', async () => {
      transmisor.enviar.mockResolvedValue(SIN_RESPUESTA);
      armador.armar.mockImplementation(async (doc: Fila) => {
        if (doc.contingencia) throw new Error('builder');
        return '<Invoice tipo="normal"/>';
      });
      const d = sembrar();
      const r = await enEmpresa(() => svc.transmitir(String(d._id), DUENO));
      expect(r.dianStatus).toBe('sent');
      expect(fila(d).contingencia).toBeUndefined();
      expect(bucket.get(fila(d).xmlPath)!.toString()).toContain('normal');
    });
  });

  describe('cola de contingencia', () => {
    const enContingencia = (cambios: Fila = {}) => {
      const d = sembrar({
        dianStatus: 'contingency',
        intentos: 3,
        contingencia: { tipo: '08', declaradaAt: new Date('2026-11-05T10:00:00Z'), referencia: { id: 'EPOS1', fecha: '2026-11-05' } },
        ...cambios,
      });
      const ruta = `einvoicing/b1/e1/docs/${String(d._id)}/documento.xml`;
      bucket.set(ruta, Buffer.from('<Invoice tipo="08"/><!--firma-->'));
      fila(d).xmlPath = ruta;
      return d;
    };

    it('la DIAN sigue caída: vuelve a la cola sin arrancar el plazo', async () => {
      transmisor.enviar.mockResolvedValue(SIN_RESPUESTA);
      const d = enContingencia();
      const r = await enEmpresa(() => svc.procesarContingencia(String(d._id)));
      expect(r.documento.dianStatus).toBe('contingency');
      expect(fila(d).contingencia.restablecidoAt).toBeUndefined();
      expect(transmisor.enviar).toHaveBeenCalledTimes(1);
      expect(armador.armar).not.toHaveBeenCalled();
    });

    it('la DIAN vuelve: envía el MISMO XML 08, estampa restablecidoAt y cierra sin notas', async () => {
      const d = enContingencia();
      const r = await enEmpresa(() => svc.procesarContingencia(String(d._id)));
      expect(log).toContain('red:EPOS1:08');
      expect(armador.armar).not.toHaveBeenCalled();
      expect(r).toMatchObject({ cerrada: true, documento: { dianStatus: 'accepted' } });
      expect(fila(d).contingencia.restablecidoAt).toBeInstanceOf(Date);
      expect(fila(d).contingencia.cerradaAt).toBeInstanceOf(Date);
    });

    it('notas: esperan a que el documento sea aceptado y después salen en orden', async () => {
      transmisor.enviar.mockImplementation(async (e: { fullNumber: string }) => {
        log.push(`red:${e.fullNumber}`);
        return e.fullNumber === 'EPOS1' ? SIN_RESPUESTA : ACEPTADA;
      });
      const d = enContingencia();
      const n1 = sembrar({ type: 'credit_note', fullNumber: 'NAC1', referenceId: d._id, tipoAmbiente: '1' });
      const n2 = sembrar({ type: 'credit_note', fullNumber: 'NAC2', referenceId: d._id, tipoAmbiente: '1' });

      // La nota sola (p. ej. la transmisión detrás de la devolución) no sale.
      const sola = await enEmpresa(() => svc.transmitir(String(n1._id), DUENO));
      expect(sola).toMatchObject({ codigo: CODIGO_ESPERA_REFERIDO, transmitido: false, dianStatus: 'draft' });

      // La DIAN sigue caída: ni el documento ni las notas.
      let r = await enEmpresa(() => svc.procesarContingencia(String(d._id)));
      expect(r.notas).toEqual([]);
      expect(log.filter((l) => l.startsWith('red:NAC'))).toEqual([]);

      // Vuelve: documento, NAC1, NAC2.
      transmisor.enviar.mockImplementation(async (e: { fullNumber: string }) => {
        log.push(`red:${e.fullNumber}`);
        return ACEPTADA;
      });
      r = await enEmpresa(() => svc.procesarContingencia(String(d._id)));
      expect(log.filter((l) => l.startsWith('red:')).slice(-3)).toEqual(['red:EPOS1', 'red:NAC1', 'red:NAC2']);
      expect(r.cerrada).toBe(true);
      expect(fila(n1).dianStatus).toBe('accepted');
      expect(fila(n2).dianStatus).toBe('accepted');
    });

    it('«ya procesado» al primer envío de la 04: restaura el XML original y anota que la contingencia no aplicó (punto 1)', async () => {
      const d = enContingencia({ type: 'invoice', fullNumber: 'FE5', contingencia: { tipo: '04', declaradaAt: new Date() } });
      const original = `einvoicing/b1/e1/docs/${String(d._id)}/original.xml`;
      bucket.set(original, Buffer.from('<Invoice tipo="normal"/><!--firma-->'));
      fila(d).contingencia.xmlOriginalPath = original;
      transmisor.enviar.mockResolvedValue({ ok: false, isValid: false, origen: 'dian', codigo: 'YA_PROCESADO_DIAN', mensajes: ['90'] });
      const r = await enEmpresa(() => svc.procesarContingencia(String(d._id)));
      expect(transmisor.consultar).toHaveBeenCalledTimes(1);
      expect(r.documento.dianStatus).toBe('accepted');
      const f = fila(d);
      expect(bucket.get(f.xmlPath)!.toString()).toContain('tipo="normal"');
      expect(f.contingencia).toMatchObject({ noAplico: true, enviosXml: 1 });
    });

    it('«ya procesado» en un envío POSTERIOR del 04/08: no restaura (puede ser el propio 04)', async () => {
      const d = enContingencia({ contingencia: { tipo: '08', declaradaAt: new Date(), enviosXml: 1 } });
      const original = `einvoicing/b1/e1/docs/${String(d._id)}/original.xml`;
      bucket.set(original, Buffer.from('<Invoice tipo="normal"/>'));
      fila(d).contingencia.xmlOriginalPath = original;
      transmisor.enviar.mockResolvedValue({ ok: false, isValid: false, origen: 'dian', codigo: 'YA_PROCESADO_DIAN', mensajes: ['90'] });
      await enEmpresa(() => svc.procesarContingencia(String(d._id)));
      expect(bucket.get(fila(d).xmlPath)!.toString()).toContain('tipo="08"');
      expect(fila(d).contingencia.noAplico).toBeUndefined();
    });

    it('una nota anterior rechazada detiene las siguientes (orden, punto 8)', async () => {
      const d = enContingencia({ dianStatus: 'accepted' });
      sembrar({ type: 'credit_note', fullNumber: 'NAC1', referenceId: d._id, dianStatus: 'rejected' });
      const n2 = sembrar({ type: 'credit_note', fullNumber: 'NAC2', referenceId: d._id });
      const r = await enEmpresa(() => svc.procesarContingencia(String(d._id)));
      expect(r.notas).toEqual([]);
      expect(fila(n2).dianStatus).toBe('draft');
      expect(transmisor.enviar).not.toHaveBeenCalled();
    });

    it('una nota rechazada deja la contingencia abierta (la ve la alerta)', async () => {
      const d = enContingencia({ dianStatus: 'accepted' });
      sembrar({ type: 'credit_note', fullNumber: 'NAC1', referenceId: d._id, dianStatus: 'rejected' });
      const r = await enEmpresa(() => svc.procesarContingencia(String(d._id)));
      expect(r.cerrada).toBe(false);
      expect(fila(d).contingencia.cerradaAt).toBeUndefined();
    });

    it('un documento normal no entra por aquí (400) y el usuario sin acceso a la sede, 403', async () => {
      const normal = sembrar();
      await expect(enEmpresa(() => svc.procesarContingencia(String(normal._id), DUENO))).rejects.toThrow(/no es de contingencia/);
      const d = enContingencia();
      const cajero = { ...DUENO, role: 'cashier', sedeIds: [String(new Types.ObjectId())] } as unknown as JwtUser;
      await expect(enEmpresa(() => svc.procesarContingencia(String(d._id), cajero))).rejects.toThrow();
    });

    it('cron: recorre la cola abierta (no lo cerrado ni lo que está en vuelo) y exige tenancy', async () => {
      const abierta = enContingencia();
      sembrar({ fullNumber: 'EPOS9', dianStatus: 'accepted', contingencia: { tipo: '07', declaradaAt: new Date(), cerradaAt: new Date() } });
      sembrar({ fullNumber: 'EPOS8', dianStatus: 'sent', contingencia: { tipo: '07', declaradaAt: new Date() } });
      const c = await enEmpresa(() => svc.transmitirContingencias(10));
      expect(c).toMatchObject({ revisados: 1, avanzados: 1, errores: 0 });
      expect(fila(abierta).dianStatus).toBe('accepted');
      await expect(svc.transmitirContingencias(10)).rejects.toThrow();
    });
  });
});
