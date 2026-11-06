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
import { HabilitacionNominaService } from './habilitacion-nomina.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const SEDE = new Types.ObjectId().toString();
const owner = { userId: 'u', email: 'o@x.co', name: 'O', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;
const otra = { ...owner, role: 'cashier', sedeIds: [new Types.ObjectId().toString()] } as unknown as JwtUser;
const EMISOR = { id: new Types.ObjectId().toString(), nitNorm: '900123456', nit: '900123456', nitDv: '7', razonSocial: 'X SAS', direccion: 'Cl 1', municipioDane: '05001' };

function armar(opts: { ambiente?: string; testSetId?: string; consulta?: any; respuestaEnvio?: any; alEnviar?: () => Promise<void> } = {}) {
  const filas: any[] = [];
  const copia = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const modelo = {
    findOne: () => ({ exec: async () => (filas[0] ? { ...filas[0], conjunto: copia(filas[0].conjunto) } : null) }),
    create: async (d: any) => {
      const f = { _id: new Types.ObjectId(), ...d };
      filas.push(f);
      return { ...f };
    },
    // Bloqueo real: solo lo toma quien lo encuentra libre o vencido.
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
      // Al salir a la red el set ya debe estar grabado como «enviando».
      grabados.push(filas[0].conjunto.documentos.filter((d: any) => d.estado === 'enviando').length);
      if (opts.alEnviar) await opts.alEnviar();
      return opts.respuestaEnvio ?? { ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: [], trackId: `T${envios.length}` };
    },
    consultar: async () => opts.consulta ?? { ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: [] },
    enviar: async () => {
      throw new Error('el set de pruebas no usa el envío sincrónico');
    },
    rangos: async () => ({ rangos: [] }),
  };
  const emisores = {
    obtenerPorSede: async () => EMISOR,
    estadoNomina: async () => ({
      tipoAmbiente: opts.ambiente ?? '2',
      habilitado: false,
      testSetId: 'testSetId' in opts ? opts.testSetId : 'TS',
      softwareId: 'sw',
      tienePin: true,
      faltaParaTransmitir: [],
    }),
    leerSecreto: async () => '12345',
  };
  const firmante = { firmar: async (xml: string) => xml };
  const audit = { record: async () => undefined };
  const s = new HabilitacionNominaService(
    modelo as any,
    emisores as any,
    firmante as any,
    { para: async () => transmisor } as any,
    audit as any,
  );
  return { s, filas, envios, grabados, opts };
}

const dentro = <T>(f: () => Promise<T>) => TenantContext.run({ businessId: 'b1' } as any, f);

describe('HabilitacionNominaService', () => {
  it('rechaza el ambiente 1 con 409 y no envía nada', async () => {
    const { s, envios } = armar({ ambiente: '1' });
    await expect(dentro(() => s.iniciar(SEDE, owner))).rejects.toBeInstanceOf(ConflictException);
    expect(envios).toHaveLength(0);
  });

  it('sin TestSetId da 409 claro', async () => {
    const { s } = armar({ testSetId: undefined });
    await expect(dentro(() => s.iniciar(SEDE, owner))).rejects.toThrow(/TestSetId/);
  });

  it('sede ajena: 403 antes de tocar nada', async () => {
    const { s, filas } = armar();
    await expect(dentro(() => s.iniciar(SEDE, otra))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dentro(() => s.consultar(SEDE, otra))).rejects.toBeInstanceOf(ForbiddenException);
    expect(filas).toHaveLength(0);
  });

  it('envía solo las 4 nóminas sintéticas (NEP) con el TestSetId; las notas esperan', async () => {
    const { s, envios, filas } = armar();
    const v = await dentro(() => s.iniciar(SEDE, owner));
    expect(envios).toHaveLength(4);
    expect(envios.every((e) => e.testSetId === 'TS' && e.fullNumber.startsWith('NEP') && e.tipo === 'payroll')).toBe(true);
    expect(envios[0].xmlFirmado).toContain('1020304050');
    expect(v.aprobada).toBe(false);
    expect(v.documentos.filter((d) => d.estado === 'enviado')).toHaveLength(4);
    expect(filas[0].conjunto.documentos.filter((d: any) => d.tipo === 'niae' && d.estado === 'pendiente')).toHaveLength(4);
  });

  it('consultar acepta lo enviado y luego iniciar manda las notas NAP', async () => {
    const { s, envios } = armar();
    await dentro(() => s.iniciar(SEDE, owner));
    const c = await dentro(() => s.consultar(SEDE, owner));
    expect(c.documentos.filter((d) => d.estado === 'aceptado')).toHaveLength(4);
    envios.length = 0;
    await dentro(() => s.iniciar(SEDE, owner));
    expect(envios).toHaveLength(4);
    expect(envios.every((e) => e.tipo === 'payroll_adjustment' && e.fullNumber.startsWith('NAP'))).toBe(true);
  });

  it('consultar sin set iniciado no crea ni envía', async () => {
    const { s, filas, envios } = armar();
    const v = await dentro(() => s.consultar(SEDE, owner));
    expect(v.estado).toBe('sin_iniciar');
    expect(filas).toHaveLength(0);
    expect(envios).toHaveLength(0);
  });

  it('graba «enviando» con número y CUNE ANTES de cada envío', async () => {
    const { s, grabados } = armar();
    await dentro(() => s.iniciar(SEDE, owner));
    expect(grabados).toEqual([1, 1, 1, 1]);
  });

  it('un set cortado en «enviando» se reconsulta por CUNE y no se reenvía con otro CUNE', async () => {
    const { s, filas, envios } = armar();
    await dentro(() => s.iniciar(SEDE, owner));
    const docs = filas[0].conjunto.documentos;
    docs[0].estado = 'enviando'; // corte de Vercel tras grabar y antes de la respuesta
    const { numero, cune } = docs[0];
    envios.length = 0;
    await dentro(() => s.consultar(SEDE, owner));
    expect(envios).toHaveLength(0);
    expect(filas[0].conjunto.documentos[0]).toMatchObject({ numero, cune, estado: 'aceptado' });
  });

  it('«enviando» que la DIAN no recibió vuelve a la cola con número nuevo', async () => {
    const { s, filas } = armar({ consulta: { ok: false, origen: 'adapter', codigo: 'NO_RECIBIDO_DIAN', mensajes: ['x'] } });
    await dentro(() => s.iniciar(SEDE, owner));
    filas[0].conjunto.documentos[0].estado = 'enviando';
    delete filas[0].conjunto.documentos[0].enviadoAt; // sin fecha de envío se renumera de inmediato
    const viejo = filas[0].conjunto.documentos[0].numero;
    await dentro(() => s.iniciar(SEDE, owner));
    expect(filas[0].conjunto.documentos[0].numero).not.toBe(viejo);
  });

  it('«enviando» sin rastro: antes de 10 min queda en vuelo; pasado el umbral se renumera', async () => {
    const { s, filas } = armar({ consulta: { ok: false, origen: 'adapter', codigo: 'NO_RECIBIDO_DIAN', mensajes: ['x'] } });
    const t0 = new Date('2026-11-05T15:00:00Z');
    await dentro(() => s.iniciar(SEDE, owner, t0));
    const d0 = filas[0].conjunto.documentos[0];
    const viejo = d0.numero;
    d0.estado = 'enviando';
    d0.enviadoAt = t0.toISOString();
    await dentro(() => s.consultar(SEDE, owner, new Date(t0.getTime() + 9 * 60_000)));
    expect(filas[0].conjunto.documentos[0]).toMatchObject({ estado: 'enviando', numero: viejo });
    await dentro(() => s.consultar(SEDE, owner, new Date(t0.getTime() + 11 * 60_000)));
    expect(filas[0].conjunto.documentos[0].estado).toBe('rechazado');
    await dentro(() => s.iniciar(SEDE, owner, new Date(t0.getTime() + 12 * 60_000)));
    expect(filas[0].conjunto.documentos[0].numero).not.toBe(viejo);
  });

  it('un envio sin trackId (timeout) se reconsulta por CUNE y, tras el umbral y NO_RECIBIDO, se renumera', async () => {
    const { s, filas, opts } = armar({ respuestaEnvio: { ok: false, origen: 'adapter', codigo: 'RED', mensajes: ['timeout'] }, consulta: { ok: false, origen: 'adapter', codigo: 'NO_RECIBIDO_DIAN', mensajes: ['x'] } });
    const t0 = new Date('2026-11-05T15:00:00Z');
    await dentro(() => s.iniciar(SEDE, owner, t0));
    const d0 = filas[0].conjunto.documentos[0];
    expect(d0).toMatchObject({ estado: 'enviado', trackId: null });
    expect(d0.enviadoAt).toBeTruthy();
    const viejo = d0.numero;
    await dentro(() => s.consultar(SEDE, owner, new Date(t0.getTime() + 9 * 60_000)));
    expect(filas[0].conjunto.documentos[0]).toMatchObject({ estado: 'enviado', numero: viejo });
    await dentro(() => s.consultar(SEDE, owner, new Date(t0.getTime() + 11 * 60_000)));
    expect(filas[0].conjunto.documentos[0].estado).toBe('rechazado');
    opts.respuestaEnvio = undefined;
    await dentro(() => s.iniciar(SEDE, owner, new Date(t0.getTime() + 12 * 60_000)));
    expect(filas[0].conjunto.documentos[0].numero).not.toBe(viejo);
  });

  it('dos llamadas cruzadas: la segunda recibe 409 sin enviar y luego trabaja sobre la copia fresca', async () => {
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    const { s, envios } = armar({ alEnviar: () => puerta });
    const a = dentro(() => s.iniciar(SEDE, owner));
    await new Promise((r) => setTimeout(r, 20));
    await expect(dentro(() => s.iniciar(SEDE, owner))).rejects.toBeInstanceOf(ConflictException);
    expect(envios).toHaveLength(1);
    soltar();
    await a;
    const b = await dentro(() => s.iniciar(SEDE, owner));
    expect(b.documentos.filter((d) => d.estado !== 'pendiente').length).toBeGreaterThanOrEqual(4);
    expect(new Set(envios.map((e) => e.fullNumber)).size).toBe(envios.length);
  });

  it('la última nota del set es de Eliminar y se envía como TipoNota 2', async () => {
    const { s, filas, envios } = armar();
    await dentro(() => s.iniciar(SEDE, owner));
    expect(filas[0].conjunto.documentos.filter((d: any) => d.nota === 'eliminar')).toHaveLength(1);
    await dentro(() => s.consultar(SEDE, owner));
    envios.length = 0;
    await dentro(() => s.iniciar(SEDE, owner));
    expect(envios.some((e) => /TipoNota[^>]*>2</.test(e.xmlFirmado))).toBe(true);
  });
});
