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

function armar(opts: { ambiente?: string; testSetId?: string } = {}) {
  const filas: any[] = [];
  const modelo = {
    findOne: () => ({ exec: async () => filas[0] ?? null }),
    create: async (d: any) => {
      const f = { _id: new Types.ObjectId(), ...d };
      filas.push(f);
      return f;
    },
    findOneAndUpdate: () => ({ exec: async () => filas[0] ?? null }),
    updateOne: (_f: any, u: any) => ({
      exec: async () => {
        Object.assign(filas[0], u.$set);
      },
    }),
  };
  const envios: any[] = [];
  const transmisor = {
    enviarSetPruebas: async (e: any) => {
      envios.push(e);
      return { ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: [], trackId: `T${envios.length}` };
    },
    consultar: async () => ({ ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: [] }),
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
  return { s, filas, envios };
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
});
