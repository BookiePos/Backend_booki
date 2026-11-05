import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
    const actual = leer(fila, k);
    if (k === '_id') return String(actual) === String(v);
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
  const copia = (f?: Fila) => (f ? { ...f } : null);
  const buscar = (filtro: Fila) => [...filas.values()].find((f) => cumple(f, filtro));
  return {
    filas,
    findById: (id: string) => ({ exec: async () => copia(filas.get(String(id))) }),
    findOne: (filtro: Fila) => ({ exec: async () => copia(buscar(filtro)) }),
    create: async (d: Fila) => {
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
    expect(f.xmlPath).toMatch(/^einvoicing\/b1\/e1\/docs\/[0-9a-f]{24}\/documento\.xml$/);
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
      const r = await emitir();
      expect(r).toMatchObject({ tipoXml: '102', fullNumber: 'NE2', dianStatus: 'accepted' });
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
});
