import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { NominaElectronicaService, contadorNomina, type ModeloNomina } from './nomina-electronica.service';
import { FirmaNoDisponibleError } from './transmision-dian.puertos';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import { StubDian } from '../domain/stub-dian';
import type { RespuestaDian, TransmisorDian } from '../domain/transmisor-dian';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { modeloAjuste, modeloIndividual } from '../domain/nomina/__fixtures__/modelo-prueba.test';

/**
 * Firma, persistencia y transmisión de la nómina con dobles del modelo, de los
 * contadores, del bucket, del firmante y del transmisor. El armador de XML y el
 * almacenamiento de rutas son los reales.
 */

const NIT = '900123456';
const SEDE = new Types.ObjectId().toString();
const ACEPTADA: RespuestaDian = { ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: ['Procesado'] };
const RECHAZADA: RespuestaDian = { ok: false, isValid: false, origen: 'dian', codigo: '99', mensajes: ['NIE123: valor no coincide'] };
const sinVeredicto = (codigo: string, extra: Partial<RespuestaDian> = {}): RespuestaDian => ({
  ok: false,
  origen: 'adapter',
  codigo,
  mensajes: [codigo],
  ...extra,
});

type Fila = Record<string, any>;

const leer = (f: Fila, ruta: string): any => ruta.split('.').reduce((a, k) => (a == null ? undefined : a[k]), f);

function cumple(fila: Fila, filtro: Record<string, any>): boolean {
  return Object.entries(filtro).every(([k, v]) => {
    if (k === '$or') return (v as Fila[]).some((x) => cumple(fila, x));
    if (k === '$and') return (v as Fila[]).every((x) => cumple(fila, x));
    const actual = leer(fila, k);
    if (v && typeof v === 'object' && '$gt' in v) return actual != null && actual > v.$gt;
    if (k === '_id') return String(actual) === String(v);
    if (actual && v && typeof actual === 'object' && typeof v === 'object' && !('$lte' in v)) return String(actual) === String(v);
    if (v === null) return actual == null;
    if (v && typeof v === 'object' && '$lte' in v) return actual != null && actual <= v.$lte;
    return actual === v;
  });
}

function aplicar(fila: Fila, u: Record<string, any>): void {
  Object.assign(fila, u.$set ?? {});
  for (const [k, n] of Object.entries(u.$inc ?? {})) fila[k] = (fila[k] ?? 0) + (n as number);
  for (const k of Object.keys(u.$unset ?? {})) delete fila[k];
}

function modeloFalso() {
  const filas = new Map<string, Fila>();
  /** Errores que `create` lanza antes de insertar (carreras de índices únicos). */
  const fallosCreate: Array<() => Error> = [];
  const copia = (f?: Fila) => (f ? { ...f } : null);
  const buscar = (filtro: Fila) => [...filas.values()].find((f) => cumple(f, filtro));
  return {
    filas,
    fallosCreate,
    findById: (id: string) => ({ exec: async () => copia(filas.get(String(id))) }),
    findOne: (filtro: Fila) => ({ exec: async () => copia(buscar(filtro)) }),
    find: (filtro: Fila) => {
      const q: any = {
        sort: () => q,
        limit: () => q,
        select: () => q,
        exec: async () => [...filas.values()].filter((f) => cumple(f, filtro)).map((f) => copia(f)),
      };
      return q;
    },
    create: async (d: Fila) => {
      const fallo = fallosCreate.shift();
      if (fallo) throw fallo();
      for (const f of filas.values()) {
        if (leer(f, 'emisor.nitNorm') === leer(d, 'emisor.nitNorm') && f.prefix === d.prefix && f.number === d.number) {
          throw Object.assign(new Error('E11000 nomina_consecutivo_unico'), { code: 11000, keyPattern: { number: 1 } });
        }
        if (
          d.tipoXml === '102' && f.tipoXml === '102' && f.vigente && d.vigente &&
          leer(f, 'emisor.nitNorm') === leer(d, 'emisor.nitNorm') && f.periodo === d.periodo &&
          leer(f, 'empleado.docNumber') === leer(d, 'empleado.docNumber')
        ) {
          throw Object.assign(new Error('E11000 nomina_102_vigente_unico'), { code: 11000, keyPattern: { periodo: 1 } });
        }
      }
      if (d.tipoXml === '103' && d.ocupaPredecesor) {
        for (const f of filas.values()) {
          if (f.tipoXml === '103' && f.ocupaPredecesor && leer(f, 'predecesor.cune') === leer(d, 'predecesor.cune')) {
            throw Object.assign(new Error('E11000 nomina_103_un_ajuste_por_predecesor'), { code: 11000, keyPattern: { 'predecesor.cune': 1 } });
          }
        }
      }
      const fila = { _id: new Types.ObjectId(), ...d };
      filas.set(String(fila._id), fila);
      return { ...fila };
    },
    findOneAndUpdate: (filtro: Fila, update: Fila) => ({
      exec: async () => {
        const f = buscar(filtro);
        if (!f) return null;
        aplicar(f, update);
        return copia(f);
      },
    }),
    updateMany: (filtro: Fila, update: Fila) => ({
      exec: async () => {
        const todas = [...filas.values()].filter((f) => cumple(f, filtro));
        todas.forEach((f) => aplicar(f, update));
        return { matchedCount: todas.length };
      },
    }),
    updateOne: (filtro: Fila, update: Fila) => ({
      exec: async () => {
        const f = buscar(filtro);
        if (f) aplicar(f, update);
        return { matchedCount: f ? 1 : 0 };
      },
    }),
  };
}

function contadoresFalsos() {
  const seqs = new Map<string, number>();
  return {
    seqs,
    findOneAndUpdate: (filtro: Fila, update: Fila) => ({
      exec: async () => {
        const id = String(filtro._id);
        if (filtro.seq !== undefined && seqs.get(id) !== filtro.seq) return null;
        const n = (seqs.get(id) ?? 0) + (update.$inc.seq as number);
        seqs.set(id, n);
        return { _id: id, seq: n };
      },
    }),
  };
}

describe('NominaElectronicaService', () => {
  let modelo: ReturnType<typeof modeloFalso>;
  let contadores: ReturnType<typeof contadoresFalsos>;
  let bucket: Map<string, Buffer>;
  let storage: EinvoicingStorageService;
  let audit: { record: ReturnType<typeof vi.fn> };
  let estado: Fila;
  let emisores: Fila;
  let firmante: { firmar: ReturnType<typeof vi.fn> };
  let transmisor: TransmisorDian & { enviar: ReturnType<typeof vi.fn>; enviarSetPruebas: ReturnType<typeof vi.fn>; consultar: ReturnType<typeof vi.fn> };
  let proveedor: { para: ReturnType<typeof vi.fn> };
  let svc: NominaElectronicaService;

  const DUENO = { userId: 'u1', email: 'd@b.co', name: 'Dueña', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;
  const AJENO = { userId: 'u2', email: 'x@b.co', name: 'X', role: 'cashier', permissions: [], sedeIds: [new Types.ObjectId().toString()] } as unknown as JwtUser;
  const enEmpresa = <T>(fn: () => Promise<T>) => TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, fn);
  const emitir = (m: ModeloNomina = modeloIndividual(), user: JwtUser | undefined = DUENO) => enEmpresa(() => svc.emitir(m, SEDE, user));
  const filasOrdenadas = () => [...modelo.filas.values()] as Fila[];

  beforeEach(() => {
    modelo = modeloFalso();
    contadores = contadoresFalsos();
    bucket = new Map();
    storage = new EinvoicingStorageService({
      uploadPrivado: async (pathname: string, contenido: Buffer) => {
        bucket.set(pathname, contenido);
        return { pathname };
      },
      descargarPrivado: async (pathname: string) => ({ buffer: bucket.get(pathname)! }),
    } as never);
    audit = { record: vi.fn(async () => undefined) };
    estado = {
      certificadoVigente: true,
      tipoAmbiente: '1',
      habilitado: true,
      softwareId: 'sw-nomina',
      tienePin: true,
      testSetId: 'ts-nomina',
      faltaParaTransmitir: [],
    };
    // Sin `estadoConfiguracion`: si el servicio mirara la factura, esto reventaría.
    emisores = {
      obtenerPorSede: vi.fn(async () => ({ id: 'e1', nitNorm: NIT, nit: NIT, nitDv: '7', razonSocial: 'Panadería' })),
      estadoNomina: vi.fn(async () => estado),
      leerSecreto: vi.fn(async (_id: string, campo: string) => (campo === 'nominaPin' ? '12345' : null)),
    };
    firmante = { firmar: vi.fn(async (xml: string) => `${xml}<!--firmado-->`) };
    transmisor = {
      enviar: vi.fn(async () => ACEPTADA),
      enviarSetPruebas: vi.fn(async () => sinVeredicto('PENDIENTE_DIAN', { origen: 'dian', trackId: 'zk-1' })),
      consultar: vi.fn(async () => ACEPTADA),
      rangos: vi.fn(),
    } as never;
    proveedor = { para: vi.fn(async () => transmisor) };
    svc = new NominaElectronicaService(modelo as never, contadores as never, emisores as never, storage, firmante as never, proveedor as never, audit as never);
  });

  it('102 en producción: número propio NE1, XML firmado al bucket, enviar con tipo payroll y aceptado', async () => {
    const r = await emitir();
    expect(r).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NE1', tipoXml: '102', periodo: '2026-10', transmitido: true, intentos: 1 });
    const f = filasOrdenadas()[0]!;
    expect(f.prefix).toBe('NE');
    expect(f.xmlPath).toMatch(/^einvoicing\/b1\/e1\/nomina\/[0-9a-f]{24}\/documento\.xml$/);
    expect(bucket.get(f.xmlPath)!.toString()).toContain('<!--firmado-->');
    expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(1);
    expect(proveedor.para).toHaveBeenCalledWith(SEDE, '1');
    expect(transmisor.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: 'payroll', fullNumber: 'NE1', cufe: r.cune, xmlFirmado: expect.stringContaining('NominaIndividual') }),
    );
    expect(transmisor.enviarSetPruebas).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'einvoicing.nomina.emitida', success: true }));
  });

  it('credenciales: solo las de NÓMINA (PIN de nómina, nunca el de la factura)', async () => {
    await emitir();
    expect(emisores.leerSecreto).toHaveBeenCalledWith('e1', 'nominaPin');
    expect(emisores.leerSecreto).not.toHaveBeenCalledWith('e1', 'facturaPin');
    expect(emisores.estadoNomina).toHaveBeenCalled();
    const xml = firmante.firmar.mock.calls[0]![0] as string;
    expect(xml).toContain('sw-nomina');
  });

  it('sin SoftwareID o PIN de nómina: CONFIG_FALTANTE, nada sale a la red y no se consume número', async () => {
    emisores.leerSecreto = vi.fn(async () => null);
    const r = await emitir();
    expect(r).toMatchObject({ codigo: 'CONFIG_FALTANTE', transmitido: false });
    estado.faltaParaTransmitir = ['PIN del software'];
    estado.tienePin = false;
    const r2 = await emitir();
    expect(r2.codigo).toBe('CONFIG_FALTANTE');
    expect(r2.mensajes.join(' ')).toContain('PIN del software');
    expect(proveedor.para).not.toHaveBeenCalled();
    expect(transmisor.enviar).not.toHaveBeenCalled();
    expect(firmante.firmar).not.toHaveBeenCalled();
    expect(contadores.seqs.size).toBe(0);
    expect(modelo.filas.size).toBe(0);
  });

  it('producción sin emisor habilitado, o habilitación sin TestSetId de nómina: no sale', async () => {
    estado.habilitado = false;
    expect((await emitir()).mensajes.join(' ')).toContain('no está habilitado para producción');
    estado.habilitado = true;
    estado.tipoAmbiente = '2';
    estado.testSetId = undefined;
    expect((await emitir()).mensajes.join(' ')).toContain('TestSetId');
    expect(transmisor.enviar).not.toHaveBeenCalled();
    expect(transmisor.enviarSetPruebas).not.toHaveBeenCalled();
    expect(modelo.filas.size).toBe(0);
  });

  it('transmisor stub (sin certificado utilizable): firma y guarda, pero no marca sent ni sale a la red', async () => {
    proveedor.para.mockResolvedValue(new StubDian('Falta configurar: certificado'));
    const r = await emitir();
    expect(r).toMatchObject({ codigo: 'CONFIG_FALTANTE', dianStatus: 'signed', transmitido: false, intentos: 0 });
    expect(filasOrdenadas()[0]!.ultimoIntentoSinRed).toMatchObject({ codigo: 'CONFIG_FALTANTE' });
  });

  it('sin .p12 utilizable para firmar: queda en borrador con su número y no sale; el reintento lo reutiliza', async () => {
    firmante.firmar.mockRejectedValueOnce(new FirmaNoDisponibleError());
    const r = await emitir();
    expect(r).toMatchObject({ codigo: 'CONFIG_FALTANTE', dianStatus: 'draft' });
    expect(transmisor.enviar).not.toHaveBeenCalled();
    const r2 = await emitir();
    expect(r2).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NE1' });
    expect(modelo.filas.size).toBe(1);
    expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(1);
  });

  it('habilitación: SendTestSetAsync con el TestSetId de nómina, queda en vuelo con trackId y consultar lo resuelve', async () => {
    estado.tipoAmbiente = '2';
    const r = await emitir();
    expect(r).toMatchObject({ dianStatus: 'sent', codigo: 'PENDIENTE_DIAN' });
    expect(transmisor.enviar).not.toHaveBeenCalled();
    expect(transmisor.enviarSetPruebas).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: 'payroll', testSetId: 'ts-nomina' }),
    );
    expect(filasOrdenadas()[0]!.trackId).toBe('zk-1');
    const c = await enEmpresa(() => svc.consultar(r.documentoId!, DUENO));
    expect(transmisor.consultar).toHaveBeenCalledWith(expect.objectContaining({ trackId: 'zk-1', cufe: r.cune }));
    expect(c.dianStatus).toBe('accepted');
    await enEmpresa(() => svc.consultar(r.documentoId!, DUENO));
    expect(transmisor.consultar).toHaveBeenCalledTimes(1);
  });

  it('rechazo con motivos: rejected; corregirlo conserva el número y se acepta', async () => {
    transmisor.enviar.mockResolvedValueOnce(RECHAZADA);
    const r = await emitir();
    expect(r).toMatchObject({ dianStatus: 'rejected', codigo: '99' });
    const f = filasOrdenadas()[0]!;
    expect(f.rechazoMotivo).toContain('NIE123');
    expect(f.respuestaDian).toMatchObject({ isValid: false });
    const r2 = await emitir();
    expect(r2).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NE1' });
    expect(modelo.filas.size).toBe(1);
    expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(1);
    expect(filasOrdenadas()[0]!.rechazoMotivo).toBeUndefined();
  });

  it('transmitir un rechazado no reenvía el mismo XML: pide corregir', async () => {
    transmisor.enviar.mockResolvedValueOnce(RECHAZADA);
    const r = await emitir();
    await expect(enEmpresa(() => svc.transmitir(r.documentoId!, DUENO))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('red caída: queda en vuelo y el reintento reenvía el MISMO XML y número', async () => {
    transmisor.enviar.mockResolvedValueOnce(sinVeredicto('RED'));
    const r = await emitir();
    expect(r).toMatchObject({ dianStatus: 'sent', codigo: 'RED', fullNumber: 'NE1' });
    const primero = (transmisor.enviar.mock.calls[0]![0] as Fila).xmlFirmado;
    const r2 = await emitir();
    expect(r2).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NE1', intentos: 2 });
    expect((transmisor.enviar.mock.calls[1]![0] as Fila).xmlFirmado).toBe(primero);
    expect(firmante.firmar).toHaveBeenCalledTimes(1);
    expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(1);
    expect(modelo.filas.size).toBe(1);
  });

  it('una excepción del transmisor es red, no veredicto', async () => {
    transmisor.enviar.mockRejectedValueOnce(new Error('ECONNRESET'));
    const r = await emitir();
    expect(r).toMatchObject({ dianStatus: 'sent', codigo: 'RED' });
  });

  it('YA_PROCESADO: no rechaza, consulta por CUNE (GetStatus) y aplica ese veredicto', async () => {
    transmisor.enviar.mockResolvedValueOnce(sinVeredicto('YA_PROCESADO_DIAN', { origen: 'dian' }));
    const r = await emitir();
    expect(transmisor.consultar).toHaveBeenCalledWith(expect.objectContaining({ cufe: r.cune }));
    expect(r).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NE1' });
  });

  describe('sin contingencia: cola y reenvío por el cron (Fase 9)', () => {
    const cron = (minutosDespues = 11) =>
      enEmpresa(() => svc.reconsultarPendientes(10, { ahora: new Date(Date.now() + minutosDespues * 60_000) }));
    const xmlEnviado = (i: number) => (transmisor.enviar.mock.calls[i]![0] as Fila).xmlFirmado as string;

    it('102 (payroll): RED → en vuelo → el cron reenvía el MISMO XML, sin refirmar ni renumerar → aceptado', async () => {
      transmisor.enviar.mockResolvedValueOnce(sinVeredicto('RED'));
      const r = await emitir();
      expect(r).toMatchObject({ dianStatus: 'sent', codigo: 'RED', fullNumber: 'NE1' });
      expect(transmisor.enviar).toHaveBeenCalledTimes(1);
      // Antes del reposo de 10 min no se toca.
      expect(await cron(5)).toMatchObject({ revisados: 0 });
      expect(await cron()).toEqual({ revisados: 1, avanzados: 1, omitidos: 0, errores: 0 });
      const f = filasOrdenadas()[0]!;
      expect(f).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NE1', intentos: 2 });
      expect(f.contingencia).toBeUndefined();
      expect(xmlEnviado(1)).toBe(xmlEnviado(0));
      expect((transmisor.enviar.mock.calls[1]![0] as Fila).tipo).toBe('payroll');
      expect(firmante.firmar).toHaveBeenCalledTimes(1);
      expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(1);
      expect(modelo.filas.size).toBe(1);
    });

    it('la DIAN sigue caída: cada corrida reenvía el mismo XML y sigue en cola, sin rechazo ni tope', async () => {
      transmisor.enviar.mockResolvedValue(sinVeredicto('RED'));
      const r = await emitir();
      const fila = modelo.filas.get(r.documentoId!)!;
      for (let i = 0; i < 5; i++) {
        fila.enviadoAt = new Date(Date.now() - 11 * 60_000);
        expect(await enEmpresa(() => svc.reconsultarPendientes(10))).toMatchObject({ revisados: 1, avanzados: 0, errores: 0 });
      }
      expect(fila).toMatchObject({ dianStatus: 'sent', fullNumber: 'NE1', intentos: 6 });
      expect(fila.rechazoMotivo).toBeUndefined();
      expect(fila.contingencia).toBeUndefined();
      expect(firmante.firmar).toHaveBeenCalledTimes(1);
      for (let i = 1; i < 6; i++) expect(xmlEnviado(i)).toBe(xmlEnviado(0));
    });

    it('YA_PROCESADO en el reenvío del cron: consulta GetStatus por CUNE y toma ese veredicto', async () => {
      transmisor.enviar
        .mockResolvedValueOnce(sinVeredicto('RED'))
        .mockResolvedValueOnce(sinVeredicto('YA_PROCESADO_DIAN', { origen: 'dian' }));
      const r = await emitir();
      expect(transmisor.consultar).not.toHaveBeenCalled();
      expect(await cron()).toMatchObject({ revisados: 1, avanzados: 1 });
      expect(transmisor.consultar).toHaveBeenCalledWith(expect.objectContaining({ cufe: r.cune }));
      expect(filasOrdenadas()[0]!).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NE1' });
    });

    it('firmado que no llegó a salir: el cron lo envía con el XML guardado cuando ya se puede', async () => {
      proveedor.para.mockResolvedValueOnce(new StubDian('Falta configurar: certificado'));
      const r = await emitir();
      expect(r).toMatchObject({ dianStatus: 'signed', transmitido: false });
      const fila = modelo.filas.get(r.documentoId!)!;
      // Recién firmado no entra; pasado el reposo, sí.
      fila.updatedAt = new Date();
      expect(await enEmpresa(() => svc.reconsultarPendientes(10))).toMatchObject({ revisados: 0 });
      fila.updatedAt = new Date(Date.now() - 11 * 60_000);
      // Sigue sin poder salir: firmado, y no cuenta como avance.
      proveedor.para.mockResolvedValueOnce(new StubDian('Falta configurar: certificado'));
      expect(await enEmpresa(() => svc.reconsultarPendientes(10))).toEqual({ revisados: 1, avanzados: 0, omitidos: 0, errores: 0 });
      expect(fila.dianStatus).toBe('signed');
      // Ya hay transmisor: sale el XML que se firmó la primera vez.
      expect(await enEmpresa(() => svc.reconsultarPendientes(10))).toMatchObject({ revisados: 1, avanzados: 1 });
      expect(fila).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NE1' });
      expect(firmante.firmar).toHaveBeenCalledTimes(1);
      expect(xmlEnviado(0)).toContain('<!--firmado-->');
    });
  });

  it('ya aceptado: emitir de nuevo no vuelve a enviar ni renumera', async () => {
    await emitir();
    const r = await emitir();
    expect(r).toMatchObject({ dianStatus: 'accepted', fullNumber: 'NE1', transmitido: false });
    expect(transmisor.enviar).toHaveBeenCalledTimes(1);
    expect(modelo.filas.size).toBe(1);
  });

  it('consecutivo atómico y propio: trabajadores distintos reciben números distintos, también en paralelo', async () => {
    const rs = await Promise.all([
      emitir(modeloIndividual({ documento: '111' })),
      emitir(modeloIndividual({ documento: '222' })),
      emitir(modeloIndividual({ documento: '333' })),
    ]);
    expect(rs.map((r) => r.fullNumber).sort()).toEqual(['NE1', 'NE2', 'NE3']);
    expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(3);
    expect([...contadores.seqs.keys()].every((k) => k.startsWith('nomina:'))).toBe(true);
  });

  it('modelo inválido: 400 y el número se devuelve (no queda hueco)', async () => {
    const m = modeloIndividual();
    m.documento.devengados.basico.sueldo = -1;
    await expect(emitir(m)).rejects.toBeInstanceOf(BadRequestException);
    expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(0);
    expect(modelo.filas.size).toBe(0);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('el NIT del modelo debe ser el del emisor de la sede', async () => {
    const m = modeloIndividual();
    m.emision.empleador.nit = '800111222';
    await expect(emitir(m)).rejects.toBeInstanceOf(BadRequestException);
    expect(contadores.seqs.size).toBe(0);
  });

  it('acceso por sede: un usuario ajeno recibe 403 y nada se toca', async () => {
    await expect(emitir(modeloIndividual(), AJENO)).rejects.toBeInstanceOf(ForbiddenException);
    expect(emisores.obtenerPorSede).not.toHaveBeenCalled();
    const r = await emitir();
    await expect(enEmpresa(() => svc.transmitir(r.documentoId!, AJENO))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(enEmpresa(() => svc.consultar(r.documentoId!, AJENO))).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('ajustes (103)', () => {
    const CUNE_PRED = 'b'.repeat(96);
    const sembrarPredecesor = async (): Promise<Fila> => {
      const r = await emitir();
      const f = modelo.filas.get(r.documentoId!)!;
      f.cune = CUNE_PRED;
      return f;
    };

    it('Reemplazar: prefijo NA con contador propio y reintentar no crea otro', async () => {
      await sembrarPredecesor();
      const r = await emitir(modeloAjuste(1, CUNE_PRED));
      expect(r).toMatchObject({ tipoXml: '103', fullNumber: 'NA1', dianStatus: 'accepted' });
      expect(transmisor.enviar).toHaveBeenLastCalledWith(expect.objectContaining({ tipo: 'payroll_adjustment' }));
      const r2 = await emitir(modeloAjuste(1, CUNE_PRED));
      expect(r2).toMatchObject({ fullNumber: 'NA1', transmitido: false });
      expect(contadores.seqs.get(contadorNomina(NIT, 'NA'))).toBe(1);
      expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(1);
    });

    it('Eliminar aceptado libera el mes: el 102 se puede volver a emitir con número nuevo', async () => {
      const pred = await sembrarPredecesor();
      await emitir(modeloAjuste(2, CUNE_PRED));
      expect(pred.vigente).toBe(false);
      expect(pred.pendienteCierrePredecesor).toBeUndefined();
      const r = await emitir();
      expect(r).toMatchObject({ tipoXml: '102', fullNumber: 'NE2', dianStatus: 'accepted' });
    });

    it('cadena completa 102 → Reemplazar → Reemplazar → Eliminar: solo el último es ajustable y Eliminar cierra todo', async () => {
      const raiz = await sembrarPredecesor();
      const CUNE_R1 = 'c'.repeat(96);
      const CUNE_R2 = 'd'.repeat(96);
      const r1 = await emitir(modeloAjuste(1, CUNE_PRED, 'NE1'));
      expect(r1.fullNumber).toBe('NA1');
      const f1 = modelo.filas.get(r1.documentoId!)!;
      f1.cune = CUNE_R1;
      expect(String(f1.raizId)).toBe(String(raiz._id));
      // El 102 raíz queda superado pero SIGUE ocupando el mes.
      expect(raiz).toMatchObject({ superado: true, vigente: true });
      // Ajustar de nuevo el 102 ya reemplazado: rechazo con mensaje claro.
      // Repetir el MISMO Reemplazar es idempotente (devuelve el NA1 aceptado); otro ajuste sobre el 102, no.
      expect((await emitir(modeloAjuste(1, CUNE_PRED, 'NE1'))).documentoId).toBe(r1.documentoId);
      await expect(emitir(modeloAjuste(2, CUNE_PRED, 'NE1'))).rejects.toThrow(/ya fue reemplazado/);
      // Sobre el último, sí.
      const r2 = await emitir(modeloAjuste(1, CUNE_R1, 'NA1'));
      expect(r2.fullNumber).toBe('NA2');
      const f2 = modelo.filas.get(r2.documentoId!)!;
      f2.cune = CUNE_R2;
      expect(String(f2.raizId)).toBe(String(raiz._id));
      expect(f1).toMatchObject({ superado: true, vigente: false });
      // Mientras la cadena vive, el mes sigue ocupado: el 102 del mes no se duplica.
      expect((await emitir()).documentoId).toBe(String(raiz._id));
      // Eliminar el último cierra toda la cadena y libera el mes.
      const e = await emitir(modeloAjuste(2, CUNE_R2, 'NA2'));
      expect(e).toMatchObject({ fullNumber: 'NA3', dianStatus: 'accepted' });
      for (const f of [raiz, f1, f2]) expect(f.vigente).toBe(false);
      const nuevo = await emitir();
      expect(nuevo).toMatchObject({ tipoXml: '102', fullNumber: 'NE2', dianStatus: 'accepted' });
      // Una eliminación no se ajusta.
      modelo.filas.get(e.documentoId!)!.cune = 'e'.repeat(96);
      await expect(emitir(modeloAjuste(1, 'e'.repeat(96), 'NA3'))).rejects.toThrow(BadRequestException);
    });

    it('un rechazo se corrige con el MISMO tipo de nota: cambiar de Reemplazar a Eliminar es un documento nuevo', async () => {
      await sembrarPredecesor();
      transmisor.enviar.mockResolvedValueOnce(RECHAZADA).mockResolvedValueOnce(RECHAZADA);
      const r = await emitir(modeloAjuste(1, CUNE_PRED));
      expect(r).toMatchObject({ dianStatus: 'rejected', fullNumber: 'NA1' });
      const e = await emitir(modeloAjuste(2, CUNE_PRED));
      expect(e.documentoId).not.toBe(r.documentoId);
      expect(e.fullNumber).toBe('NA2');
      // El Reemplazar rechazado no se tocó.
      expect(modelo.filas.get(r.documentoId!)).toMatchObject({ tipoNota: 1, dianStatus: 'rejected', fullNumber: 'NA1' });
      expect(modelo.filas.get(e.documentoId!)).toMatchObject({ tipoNota: 2 });
      // Y reintentar el Reemplazar rechazado conserva su número y su tipo.
      const r3 = await emitir(modeloAjuste(1, CUNE_PRED));
      expect(r3).toMatchObject({ documentoId: r.documentoId, fullNumber: 'NA1' });
    });

    it('un Reemplazar en vuelo bloquea un Eliminar sobre el mismo predecesor (409); tras el rechazo se puede cambiar de tipo', async () => {
      await sembrarPredecesor();
      transmisor.enviar.mockResolvedValueOnce(sinVeredicto('RED'));
      const r = await emitir(modeloAjuste(1, CUNE_PRED));
      expect(r.dianStatus).toBe('sent');
      await expect(emitir(modeloAjuste(2, CUNE_PRED))).rejects.toThrow(/ajuste en curso o aceptado/);
      await expect(emitir(modeloAjuste(2, CUNE_PRED))).rejects.toBeInstanceOf(ConflictException);
      expect(modelo.filas.size).toBe(2); // el 102 y el Reemplazar
      // La DIAN rechaza el Reemplazar: ya se puede emitir el Eliminar, y el rechazado sigue sin ocupar nada.
      transmisor.enviar.mockResolvedValueOnce(RECHAZADA);
      await emitir(modeloAjuste(1, CUNE_PRED));
      expect(modelo.filas.get(r.documentoId!)).toMatchObject({ dianStatus: 'rejected', ocupaPredecesor: false });
      const e = await emitir(modeloAjuste(2, CUNE_PRED));
      expect(e).toMatchObject({ tipoXml: '103', dianStatus: 'accepted' });
      // Y ahora el Reemplazar rechazado ya no puede volver (el Eliminar ocupa el predecesor).
      await expect(emitir(modeloAjuste(1, CUNE_PRED))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un rechazado se reintenta con el mismo tipo sin conflicto', async () => {
      await sembrarPredecesor();
      transmisor.enviar.mockResolvedValueOnce(RECHAZADA);
      const r = await emitir(modeloAjuste(1, CUNE_PRED));
      expect(modelo.filas.get(r.documentoId!)!.ocupaPredecesor).toBe(false);
      const r2 = await emitir(modeloAjuste(1, CUNE_PRED));
      expect(r2).toMatchObject({ documentoId: r.documentoId, dianStatus: 'accepted' });
    });

    it('carrera: E11000 del índice de un ajuste por predecesor (otro tipo ganó) → 409 y el número se devuelve', async () => {
      await sembrarPredecesor();
      modelo.fallosCreate.push(() =>
        Object.assign(new Error('E11000 nomina_103_un_ajuste_por_predecesor'), { code: 11000, keyPattern: { 'emisor.nitNorm': 1, 'predecesor.cune': 1 } }),
      );
      await expect(emitir(modeloAjuste(1, CUNE_PRED))).rejects.toBeInstanceOf(ConflictException);
      expect(contadores.seqs.get(contadorNomina(NIT, 'NA'))).toBe(0);
      expect(modelo.filas.size).toBe(1);
    });

    it('un ajuste aceptado con cierre pendiente se repara antes de decidir quién es la cabeza', async () => {
      const raiz = await sembrarPredecesor();
      const CUNE_R1 = 'c'.repeat(96);
      // El Reemplazar se acepta pero el cierre del 102 falla.
      const original = modelo.updateOne;
      modelo.updateOne = () => ({ exec: async () => { throw new Error('base caída'); } }) as never;
      const r1 = await emitir(modeloAjuste(1, CUNE_PRED));
      modelo.updateOne = original;
      const f1 = modelo.filas.get(r1.documentoId!)!;
      f1.cune = CUNE_R1;
      expect(f1.pendienteCierrePredecesor).toBe(true);
      expect(raiz.superado).toBeUndefined();
      // Un segundo ajuste sobre el 102 repara el cierre y se rechaza por superado (no por 409 confuso).
      await expect(emitir(modeloAjuste(2, CUNE_PRED))).rejects.toThrow(/ya fue reemplazado/);
      expect(raiz.superado).toBe(true);
      expect(f1.pendienteCierrePredecesor).toBeUndefined();
      // Y sobre el nuevo último, sí.
      expect((await emitir(modeloAjuste(2, CUNE_R1, 'NA1'))).dianStatus).toBe('accepted');
    });

    it('Reemplazar con otro trabajador o mes que el predecesor: 400', async () => {
      await sembrarPredecesor();
      const otroTrabajador = modeloAjuste(1, CUNE_PRED);
      if ('documento' in otroTrabajador) otroTrabajador.documento.trabajador.numeroDocumento = '999';
      await expect(emitir(otroTrabajador)).rejects.toThrow(/trabajador o el mes/);
      const otroMes = modeloAjuste(1, CUNE_PRED);
      if ('documento' in otroMes) otroMes.documento.periodo.fechaLiquidacionFin = '2026-09-30';
      await expect(emitir(otroMes)).rejects.toThrow(/trabajador o el mes/);
    });

    it('si no se pudo cerrar la cadena queda pendiente y consultar la repara de forma idempotente', async () => {
      const pred = await sembrarPredecesor();
      const original = modelo.updateMany;
      modelo.updateMany = () => ({ exec: async () => { throw new Error('base caída'); } }) as never;
      const e = await emitir(modeloAjuste(2, CUNE_PRED));
      expect(e.dianStatus).toBe('accepted');
      const fila = modelo.filas.get(e.documentoId!)!;
      expect(fila.pendienteCierrePredecesor).toBe(true);
      expect(pred.vigente).toBe(true);
      modelo.updateMany = original;
      await enEmpresa(() => svc.consultar(e.documentoId!, DUENO));
      expect(pred.vigente).toBe(false);
      expect(fila.pendienteCierrePredecesor).toBeUndefined();
      await enEmpresa(() => svc.consultar(e.documentoId!, DUENO));
      expect(pred.vigente).toBe(false);
    });

    it('no ajusta un documento que la DIAN aún no aceptó', async () => {
      transmisor.enviar.mockResolvedValueOnce(sinVeredicto('RED'));
      const r = await emitir();
      modelo.filas.get(r.documentoId!)!.cune = CUNE_PRED;
      await expect(emitir(modeloAjuste(2, CUNE_PRED))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Eliminar sin el predecesor en BookiPos no se puede (no se conoce al trabajador)', async () => {
      await expect(emitir(modeloAjuste(2, CUNE_PRED))).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('carreras de índices únicos', () => {
    const dup = (keyPattern: Fila) => () =>
      Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern });

    it('consecutivo ocupado (E11000 sobre el número): reintenta con OTRO número', async () => {
      modelo.fallosCreate.push(dup({ 'emisor.nitNorm': 1, prefix: 1, number: 1 }));
      const r = await emitir();
      expect(r).toMatchObject({ fullNumber: 'NE2', dianStatus: 'accepted' });
      expect(modelo.filas.size).toBe(1);
      expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(2);
    });

    it('102 vigente ganado por otra emisión (E11000 sobre el periodo): devuelve al ganador sin enviar ni dejar hueco', async () => {
      const ganador = {
        _id: new Types.ObjectId(),
        sedeId: new Types.ObjectId(SEDE),
        emisor: { nitNorm: NIT },
        empleado: { docNumber: '1017123456' },
        periodo: '2026-10',
        tipoXml: '102',
        vigente: true,
        prefix: 'NE',
        number: 1,
        fullNumber: 'NE1',
        dianStatus: 'sent',
        cune: 'g'.repeat(96),
        intentos: 1,
      };
      modelo.fallosCreate.push(() => {
        modelo.filas.set(String(ganador._id), ganador); // la otra emisión insertó justo antes
        return dup({ 'emisor.nitNorm': 1, periodo: 1, 'empleado.docNumber': 1 })();
      });
      const r = await emitir();
      expect(r).toMatchObject({ documentoId: String(ganador._id), fullNumber: 'NE1', codigo: 'EN_CURSO', transmitido: false });
      expect(transmisor.enviar).not.toHaveBeenCalled();
      expect(firmante.firmar).not.toHaveBeenCalled();
      expect(modelo.filas.size).toBe(1);
      // El número que se había tomado se devolvió.
      expect(contadores.seqs.get(contadorNomina(NIT, 'NE'))).toBe(0);
    });
  });

  describe('auditoría y bucket', () => {
    it('consultar deja fila GET aunque no salga a la red, y también al fallar', async () => {
      const r = await emitir();
      audit.record.mockClear();
      await enEmpresa(() => svc.consultar(r.documentoId!, DUENO)); // aceptado: sin red
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', action: 'einvoicing.nomina.consultada', success: true, path: `/einvoicing/nomina/${r.documentoId}` }),
      );
      audit.record.mockClear();
      await expect(enEmpresa(() => svc.consultar(r.documentoId!, AJENO))).rejects.toBeInstanceOf(ForbiddenException);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', success: false }));
    });

    it('transmitir audita POST en su ruta; sin usuario (sistema) queda SERVER', async () => {
      transmisor.enviar.mockResolvedValueOnce(sinVeredicto('RED'));
      const r = await emitir();
      audit.record.mockClear();
      await enEmpresa(() => svc.transmitir(r.documentoId!, DUENO));
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: `/einvoicing/nomina/${r.documentoId}/transmitir` }),
      );
      audit.record.mockClear();
      await enEmpresa(() => svc.emitir(modeloIndividual({ documento: '555' }), SEDE));
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ method: 'SERVER' }));
    });

    it('el XML vive bajo nomina/<docId>/, no bajo docs/', async () => {
      await emitir();
      expect([...bucket.keys()][0]).toMatch(/^einvoicing\/b1\/e1\/nomina\/[0-9a-f]{24}\/documento\.xml$/);
    });
  });
});
