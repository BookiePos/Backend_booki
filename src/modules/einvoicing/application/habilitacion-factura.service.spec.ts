import { describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { HabilitacionFacturaService } from './habilitacion-factura.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { RESOLUCION_SETP, SET_FACTURA_EXIGIDO } from '../domain/habilitacion/set-habilitacion-factura';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const SEDE = new Types.ObjectId().toString();
const owner = { userId: 'u', email: 'o@x.co', name: 'O', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;
const otra = { ...owner, role: 'cashier', sedeIds: [new Types.ObjectId().toString()] } as unknown as JwtUser;
const EMISOR = {
  id: new Types.ObjectId().toString(),
  nit: '900123456-8',
  nitNorm: '900123456',
  nitDv: '8',
  razonSocial: 'Crunchy Pruebas S.A.S.',
  tipoPersona: 'juridica',
  responsabilidadFiscal: 'responsable_iva',
  direccion: 'Calle 10 # 43-12',
  ciudad: 'Medellín',
  departamento: 'Antioquia',
  emailFacturacion: 'facturacion@crunchy.co',
  municipioDane: '05001',
  responsableIva: true,
};
const EXIGIDAS = SET_FACTURA_EXIGIDO.fv;
const OK = { ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: [] };

function armar(
  opts: {
    ambiente?: string;
    testSetId?: string;
    falta?: string[];
    softwareId?: string;
    consulta?: any;
    respuestaEnvio?: any;
    alEnviar?: () => Promise<void>;
  } = {},
) {
  const filas: any[] = [];
  const copia = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const modelo = {
    find: () => ({ sort: () => ({ exec: async () => filas.map((f) => ({ ...f, conjunto: copia(f.conjunto) })) }) }),
    findOne: () => ({ exec: async () => (filas[0] ? { ...filas[0], conjunto: copia(filas[0].conjunto) } : null) }),
    create: async (d: any) => {
      const f = { _id: new Types.ObjectId(), ...d };
      filas.push(f);
      return { ...f };
    },
    findOneAndUpdate: (_f: any, u: any) => ({
      exec: async () => {
        const f = filas[0];
        if (!f || (f.bloqueoHasta && f.bloqueoHasta > new Date())) return null;
        Object.assign(f, u.$set);
        return { ...f, conjunto: copia(f.conjunto) };
      },
    }),
    updateOne: (filtro: any, u: any) => ({
      exec: async () => {
        if (filtro.bloqueo && filas[0].bloqueo !== filtro.bloqueo) return;
        Object.assign(filas[0], copia(u.$set ?? {}));
        for (const k of Object.keys(u.$unset ?? {})) delete filas[0][k];
      },
    }),
  };
  const envios: any[] = [];
  const grabados: number[] = [];
  const transmisor = {
    enviarSetPruebas: async (e: any) => {
      envios.push(e);
      grabados.push(filas[0].conjunto.documentos.filter((d: any) => d.estado === 'enviando').length);
      if (opts.alEnviar) await opts.alEnviar();
      return opts.respuestaEnvio ?? { ...OK, trackId: `T${envios.length}` };
    },
    consultar: async () => opts.consulta ?? OK,
    enviar: async () => {
      throw new Error('el set de pruebas no usa el envío sincrónico');
    },
    rangos: async () => ({ rangos: [] }),
  };
  const marcados: Array<[string, string]> = [];
  const emisores = {
    obtenerPorSede: async () => EMISOR,
    estadoFactura: async () => ({
      tipoAmbiente: opts.ambiente ?? '2',
      habilitado: false,
      testSetId: 'testSetId' in opts ? opts.testSetId : 'TS',
      softwareId: 'softwareId' in opts ? opts.softwareId : '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0',
      tienePin: true,
      certificadoVigente: true,
      faltaParaTransmitir: opts.falta ?? [],
    }),
    leerSecreto: async () => '12345',
    marcarSetAprobado: async (id: string, clase: string) => {
      marcados.push([id, clase]);
    },
  };
  const firmante = { firmar: async (xml: string) => xml };
  const s = new HabilitacionFacturaService(
    modelo as any,
    emisores as any,
    firmante as any,
    { para: async () => transmisor } as any,
    { record: async () => undefined } as any,
  );
  return { s, filas, envios, grabados, marcados, opts };
}

const dentro = <T>(f: () => Promise<T>) => TenantContext.run({ businessId: 'b1' } as any, f);

describe('HabilitacionFacturaService', () => {
  it('rechaza el ambiente 1 con 409 y no envía ni crea nada', async () => {
    const { s, envios, filas } = armar({ ambiente: '1' });
    await expect(dentro(() => s.iniciar(SEDE, owner))).rejects.toBeInstanceOf(ConflictException);
    await expect(dentro(() => s.iniciar(SEDE, owner))).rejects.toThrow(/ambiente de habilitación/);
    expect(envios).toHaveLength(0);
    expect(filas).toHaveLength(0);
  });

  it('sin TestSetId da 409 claro', async () => {
    const { s } = armar({ testSetId: undefined });
    await expect(dentro(() => s.iniciar(SEDE, owner))).rejects.toThrow(/TestSetId/);
  });

  it('sin .p12 vigente da 409 y no envía', async () => {
    const { s, envios } = armar({ falta: ['certificado .p12 vigente'] });
    await expect(dentro(() => s.iniciar(SEDE, owner))).rejects.toThrow(/certificado/);
    expect(envios).toHaveLength(0);
  });

  it('sin SoftwareID/PIN de factura da 409', async () => {
    const { s, envios } = armar({ softwareId: undefined });
    await expect(dentro(() => s.iniciar(SEDE, owner))).rejects.toThrow(/SoftwareID/);
    expect(envios).toHaveLength(0);
  });

  it('sede ajena: 403 antes de tocar nada', async () => {
    const { s, filas } = armar();
    await expect(dentro(() => s.iniciar(SEDE, otra))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dentro(() => s.consultar(SEDE, otra))).rejects.toBeInstanceOf(ForbiddenException);
    expect(filas).toHaveLength(0);
  });

  it('el POS está desactivado: 409 con el motivo y nada se crea', async () => {
    const { s, filas, envios } = armar();
    await expect(dentro(() => s.iniciar(SEDE, owner, 'pos'))).rejects.toThrow(/equivalente POS está desactivada/);
    await expect(dentro(() => s.consultar(SEDE, owner, 'pos'))).rejects.toBeInstanceOf(ConflictException);
    expect(filas).toHaveLength(0);
    expect(envios).toHaveLength(0);
  });

  it('aislamiento: envía 8 facturas SETP sintéticas al DIAN y solo escribe su propia colección', async () => {
    const { s, envios, filas, marcados } = armar();
    const v = await dentro(() => s.iniciar(SEDE, owner));
    expect(envios).toHaveLength(EXIGIDAS);
    for (const e of envios) {
      expect(e.testSetId).toBe('TS');
      expect(e.tipo).toBe('invoice');
      const n = Number(e.fullNumber.replace('SETP', ''));
      expect(e.fullNumber.startsWith('SETP')).toBe(true);
      expect(n).toBeGreaterThan(RESOLUCION_SETP.desde);
      expect(n).toBeLessThan(RESOLUCION_SETP.hasta);
      expect(e.xmlFirmado).toContain('<sts:Prefix>SETP</sts:Prefix>');
      // Adquiriente de prueba (la DIAN), no un cliente real.
      expect(e.xmlFirmado).toContain('800197268');
    }
    expect(new Set(envios.map((e) => e.fullNumber)).size).toBe(EXIGIDAS);
    expect(v.aprobada).toBe(false);
    expect(v.documentos.filter((d) => d.tipo === 'fv').every((d) => d.estado === 'enviado')).toBe(true);
    expect(v.documentos.filter((d) => d.tipo !== 'fv').every((d) => d.estado === 'pendiente')).toBe(true);
    expect(filas).toHaveLength(1);
    expect(filas[0].clase).toBe('fe');
    expect(marcados).toHaveLength(0); // sin aceptación no hay listo para producción
  });

  it('las notas solo salen cuando su factura está aceptada, referidas a ella', async () => {
    const { s, envios, filas } = armar();
    await dentro(() => s.iniciar(SEDE, owner));
    expect(envios.map((e) => e.tipo)).toEqual(Array(EXIGIDAS).fill('invoice'));
    // Con las facturas solo enviadas (sin veredicto) otra corrida no manda notas.
    const sinVeredicto = armar({ consulta: { ok: false, origen: 'adapter', codigo: 'RED', mensajes: ['x'] } });
    await dentro(() => sinVeredicto.s.iniciar(SEDE, owner));
    await dentro(() => sinVeredicto.s.iniciar(SEDE, owner));
    expect(sinVeredicto.envios).toHaveLength(EXIGIDAS);
    // Aceptadas las facturas, salen la NC (91) y la ND con referencia a una factura aceptada.
    await dentro(() => s.consultar(SEDE, owner));
    envios.length = 0;
    await dentro(() => s.iniciar(SEDE, owner));
    expect(envios.map((e) => e.tipo)).toEqual(['credit_note', 'debit_note']);
    const base = filas[0].conjunto.documentos.find((d: any) => d.tipo === 'fv' && d.estado === 'aceptado');
    for (const e of envios) {
      expect(e.xmlFirmado).toContain(`SETP${base.numero}`);
      expect(e.xmlFirmado).toContain(base.codigo);
    }
    expect(envios[0].xmlFirmado).toContain('<cbc:CreditNoteTypeCode>91<');
  });

  it('un envio sin trackId (timeout) se reconsulta por CUFE y, tras el umbral y NO_RECIBIDO, se renumera', async () => {
    const { s, filas, opts } = armar({
      respuestaEnvio: { ok: false, origen: 'adapter', codigo: 'RED', mensajes: ['timeout'] },
      consulta: { ok: false, origen: 'adapter', codigo: 'NO_RECIBIDO_DIAN', mensajes: ['x'] },
    });
    const t0 = new Date('2026-11-05T15:00:00Z');
    await dentro(() => s.iniciar(SEDE, owner, 'fe', t0));
    const d0 = filas[0].conjunto.documentos[0];
    expect(d0).toMatchObject({ estado: 'enviado', trackId: null });
    expect(d0.enviadoAt).toBeTruthy();
    const viejo = d0.numero;
    await dentro(() => s.consultar(SEDE, owner, 'fe', new Date(t0.getTime() + 9 * 60_000)));
    expect(filas[0].conjunto.documentos[0]).toMatchObject({ estado: 'enviado', numero: viejo });
    await dentro(() => s.consultar(SEDE, owner, 'fe', new Date(t0.getTime() + 11 * 60_000)));
    expect(filas[0].conjunto.documentos[0].estado).toBe('rechazado');
    opts.respuestaEnvio = undefined;
    await dentro(() => s.iniciar(SEDE, owner, 'fe', new Date(t0.getTime() + 12 * 60_000)));
    expect(filas[0].conjunto.documentos[0].numero).not.toBe(viejo);
  });

  it('consultar sin set iniciado no crea ni envía', async () => {
    const { s, filas, envios } = armar();
    const v = await dentro(() => s.consultar(SEDE, owner));
    expect(v.estado).toBe('sin_iniciar');
    expect(filas).toHaveLength(0);
    expect(envios).toHaveLength(0);
  });

  it('graba enviando con número y CUFE ANTES de cada envío', async () => {
    const { s, grabados, filas } = armar();
    await dentro(() => s.iniciar(SEDE, owner));
    expect(grabados).toEqual(Array(EXIGIDAS).fill(1));
    expect(filas[0].conjunto.documentos[0].codigo).toMatch(/^[0-9a-f]{96}$/);
  });

  it('al aceptar todo marca el emisor listo para producción, una sola vez, sin pasarlo a producción', async () => {
    const { s, marcados, opts, filas } = armar();
    await dentro(() => s.iniciar(SEDE, owner));
    await dentro(() => s.consultar(SEDE, owner));
    await dentro(() => s.iniciar(SEDE, owner)); // salen las notas
    const local = await dentro(() => s.consultar(SEDE, owner));
    // Todo aceptado por el conteo local, pero sin el veredicto del SET de la DIAN no se marca nada.
    expect(local.aprobada).toBe(true);
    expect(local.listoParaProduccion).toBe(false);
    expect(local.mensaje).toMatch(/falta el veredicto del set/);
    expect(marcados).toHaveLength(0);
    // La DIAN da el veredicto del set: la última nota se acepta con «Set de prueba … Aceptado».
    filas[0].conjunto.documentos[filas[0].conjunto.documentos.length - 1].estado = 'enviado';
    opts.consulta = { ...OK, mensajes: ['Set de prueba con identificador TS se encuentra Aceptado.'] };
    const c = await dentro(() => s.consultar(SEDE, owner));
    expect(c.listoParaProduccion).toBe(true);
    expect(c.mensaje).toMatch(/dueño/);
    await dentro(() => s.consultar(SEDE, owner));
    expect(marcados).toEqual([[EMISOR.id, 'fe']]);
  });

  it('Set de prueba se encuentra Aceptado (IsValid=false) aprueba el set y corta los envíos', async () => {
    const { s, envios } = armar({
      respuestaEnvio: {
        ok: false,
        isValid: false,
        origen: 'dian',
        codigo: '99',
        mensajes: ['Set de prueba con identificador TS se encuentra Aceptado.'],
      },
    });
    const v = await dentro(() => s.iniciar(SEDE, owner));
    expect(v.aprobada).toBe(true);
    expect(envios).toHaveLength(1);
    expect(v.documentos[0]!.estado).toBe('set_aceptado');
  });

  it('un set cortado en enviando se reconsulta por CUFE y no se reenvía con otro CUFE', async () => {
    const { s, filas, envios } = armar();
    await dentro(() => s.iniciar(SEDE, owner));
    const docs = filas[0].conjunto.documentos;
    docs[0].estado = 'enviando';
    const { numero, codigo } = docs[0];
    envios.length = 0;
    await dentro(() => s.consultar(SEDE, owner));
    expect(envios).toHaveLength(0);
    expect(filas[0].conjunto.documentos[0]).toMatchObject({ numero, codigo, estado: 'aceptado' });
  });

  it('enviando sin rastro: antes de 10 min queda en vuelo; pasado el umbral se renumera', async () => {
    const { s, filas } = armar({ consulta: { ok: false, origen: 'adapter', codigo: 'NO_RECIBIDO_DIAN', mensajes: ['x'] } });
    const t0 = new Date('2026-11-05T15:00:00Z');
    await dentro(() => s.iniciar(SEDE, owner, 'fe', t0));
    const d0 = filas[0].conjunto.documentos[0];
    const viejo = d0.numero;
    d0.estado = 'enviando';
    d0.enviadoAt = t0.toISOString();
    await dentro(() => s.consultar(SEDE, owner, 'fe', new Date(t0.getTime() + 9 * 60_000)));
    expect(filas[0].conjunto.documentos[0]).toMatchObject({ estado: 'enviando', numero: viejo });
    await dentro(() => s.consultar(SEDE, owner, 'fe', new Date(t0.getTime() + 11 * 60_000)));
    expect(filas[0].conjunto.documentos[0].estado).toBe('rechazado');
    await dentro(() => s.iniciar(SEDE, owner, 'fe', new Date(t0.getTime() + 12 * 60_000)));
    expect(filas[0].conjunto.documentos[0].numero).not.toBe(viejo);
    expect(filas[0].conjunto.historial).toHaveLength(1);
  });

  it('carrera: la segunda llamada recibe 409 sin enviar y luego trabaja sobre la copia fresca', async () => {
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    const { s, envios } = armar({ alEnviar: () => puerta });
    const a = dentro(() => s.iniciar(SEDE, owner));
    await new Promise((r) => setTimeout(r, 20));
    await expect(dentro(() => s.iniciar(SEDE, owner))).rejects.toBeInstanceOf(ConflictException);
    expect(envios).toHaveLength(1);
    soltar();
    await a;
    expect(new Set(envios.map((e) => e.fullNumber)).size).toBe(envios.length);
  });

  describe('avanzarEnCurso (cron)', () => {
    it('avanza con su GET los sets en curso, sin enviar nada nuevo', async () => {
      const { s, envios, marcados, opts } = armar();
      await dentro(() => s.iniciar(SEDE, owner));
      await dentro(() => s.avanzarEnCurso(10)); // acepta las facturas; las notas no salen desde el cron
      await dentro(() => s.iniciar(SEDE, owner)); // salen las notas
      envios.length = 0;
      opts.consulta = { ...OK, mensajes: ['Set de prueba con identificador TS se encuentra Aceptado.'] };
      const c = await dentro(() => s.avanzarEnCurso(10));
      expect(c).toMatchObject({ revisados: 1, avanzados: 1, errores: 0 });
      expect(envios).toHaveLength(0);
      expect(marcados).toEqual([[EMISOR.id, 'fe']]);
      // Aprobado: el cron ya no lo revisa.
      expect(await dentro(() => s.avanzarEnCurso(10))).toMatchObject({ revisados: 0 });
    });

    it('respeta el plazo hasta', async () => {
      const { s } = armar();
      await dentro(() => s.iniciar(SEDE, owner));
      const c = await dentro(() => s.avanzarEnCurso(10, { hasta: Date.now() - 1 }));
      expect(c.revisados).toBe(0);
    });

    it('en ambiente 1 cuenta el set como omitido y no marca nada', async () => {
      const { s, filas } = armar();
      await dentro(() => s.iniciar(SEDE, owner));
      const otro = armar({ ambiente: '1' });
      otro.filas.push(filas[0]);
      const c = await dentro(() => otro.s.avanzarEnCurso(10));
      expect(c.revisados).toBe(1);
      expect(c.omitidos + c.errores).toBe(1);
      expect(otro.marcados).toHaveLength(0);
    });
  });
});

