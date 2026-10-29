import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

// Patrón de `orders.service.checkout.spec.ts`: el servicio importa esquemas.
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

import { FiscalEmittersService } from './fiscal-emitters.service';
import {
  contextoSecreto,
  descifrar,
  SecretoIlegibleError,
  VARIABLE_LLAVE,
} from '../../../shared/crypto/secretos';
import { StubDian } from '../domain/stub-dian';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** Documento falso con `id`, `_id` y `get`, como uno hidratado. */
function doc(campos: Record<string, any>) {
  const d: any = { ...campos };
  d.id = String(d._id);
  d.get = (k: string) => d[k];
  return d;
}

const chain = (valor: unknown) => {
  const c: any = { select: () => c, exec: () => Promise.resolve(valor) };
  return c;
};

describe('FiscalEmittersService', () => {
  const llaveAnterior = process.env[VARIABLE_LLAVE];
  let emisores: Map<string, any>;
  let sedes: Map<string, any>;
  let model: any;
  let sedeModel: any;
  let svc: FiscalEmittersService;

  const nuevaSede = (campos: Record<string, any> = {}) => {
    const _id = new Types.ObjectId();
    const s = doc({ _id, name: 'Centro', businessName: 'Crunchy SAS', nit: '900.123.456-7', ...campos });
    sedes.set(String(_id), s);
    return String(_id);
  };

  beforeEach(() => {
    process.env[VARIABLE_LLAVE] = randomBytes(32).toString('base64');
    emisores = new Map();
    sedes = new Map();
    model = {
      findById: vi.fn((id: unknown) => chain(emisores.get(String(id)) ?? null)),
      findOne: vi.fn((f: { nitNorm: string }) =>
        chain([...emisores.values()].find((e) => e.nitNorm === f.nitNorm) ?? null),
      ),
      create: vi.fn(async (datos: Record<string, unknown>) => {
        const e = doc({ _id: new Types.ObjectId(), tipoAmbiente: '2', habilitado: false, ...datos });
        emisores.set(e.id, e);
        return e;
      }),
      updateOne: vi.fn((f: { _id: unknown }, u: { $set: Record<string, unknown> }) => {
        Object.assign(emisores.get(String(f._id)), u.$set);
        return chain({ acknowledged: true });
      }),
    };
    sedeModel = {
      findById: vi.fn((id: string) => chain(sedes.get(id) ?? null)),
      updateOne: vi.fn((f: { _id: unknown }, u: { $set: Record<string, unknown> }) => {
        Object.assign(sedes.get(String(f._id)), u.$set);
        return chain({ acknowledged: true });
      }),
    };
    svc = new FiscalEmittersService(model, sedeModel);
  });

  afterEach(() => {
    if (llaveAnterior === undefined) delete process.env[VARIABLE_LLAVE];
    else process.env[VARIABLE_LLAVE] = llaveAnterior;
  });

  describe('asegurarParaSede y obtenerPorSede', () => {
    it('crea el emisor desde la sede y la deja apuntando a él', async () => {
      const s = nuevaSede();
      expect(await svc.obtenerPorSede(s)).toBeNull();
      const e = await svc.asegurarParaSede(s);
      expect(e.nitNorm).toBe('900123456');
      expect(e.razonSocial).toBe('Crunchy SAS');
      expect(String(sedes.get(s).emisorId)).toBe(e.id);
      expect((await svc.obtenerPorSede(s))?.id).toBe(e.id);
    });

    it('dos sedes con el mismo NIT comparten emisor y no se pisan los datos', async () => {
      const a = await svc.asegurarParaSede(nuevaSede());
      const b = await svc.asegurarParaSede(nuevaSede({ nit: '900123456', businessName: 'Otra' }));
      expect(b.id).toBe(a.id);
      expect(b.razonSocial).toBe('Crunchy SAS');
      expect(model.create).toHaveBeenCalledTimes(1);
    });

    it('es idempotente', async () => {
      const s = nuevaSede();
      const a = await svc.asegurarParaSede(s);
      const b = await svc.asegurarParaSede(s);
      expect(b.id).toBe(a.id);
      expect(model.create).toHaveBeenCalledTimes(1);
    });

    it('si el NIT de la sede cambió, la reenlaza al emisor del NIT nuevo', async () => {
      const s = nuevaSede();
      const a = await svc.asegurarParaSede(s);
      sedes.get(s).nit = '800111222';
      const b = await svc.asegurarParaSede(s);
      expect(b.id).not.toBe(a.id);
      expect(String(sedes.get(s).emisorId)).toBe(b.id);
    });

    it('enlace viejo (la sede cambió de NIT): obtenerPorSede da null y el transmisor cae al stub', async () => {
      const s = nuevaSede();
      await svc.asegurarParaSede(s);
      sedes.get(s).nit = '800111222';
      const warn = vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      expect(await svc.obtenerPorSede(s)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/800111222|900123456/);
      const r = await (await svc.transmisorParaSede(s)).enviar({ tipo: 'invoice', fullNumber: 'FE1' });
      expect(r.codigo).toBe('CONFIG_FALTANTE');
      expect(r.mensajes[0]).toContain('no tiene emisor');
    });

    it('una creación simultánea (E11000) se queda con el emisor que ganó', async () => {
      const s = nuevaSede();
      const ganador = doc({ _id: new Types.ObjectId(), nitNorm: '900123456' });
      model.findOne
        .mockImplementationOnce(() => chain(null))
        .mockImplementationOnce(() => chain(ganador));
      model.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
      expect((await svc.asegurarParaSede(s)).id).toBe(ganador.id);
    });

    it('otro error al crear se propaga', async () => {
      model.create.mockRejectedValueOnce(new Error('caído'));
      await expect(svc.asegurarParaSede(nuevaSede())).rejects.toThrow('caído');
    });

    it('sede sin NIT: no se le asigna emisor', async () => {
      await expect(svc.asegurarParaSede(nuevaSede({ nit: undefined }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('sede inexistente o id inválido: 404', async () => {
      await expect(svc.obtenerPorSede('no-es-id')).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.obtenerPorSede(new Types.ObjectId().toString())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('credenciales cifradas', () => {
    it('cifra PIN y contraseña con el contexto <emisorId>:<campo> y descifran', async () => {
      const e = await svc.asegurarParaSede(nuevaSede());
      await svc.guardarCredenciales(e.id, {
        facturaSoftwareId: 'sw-fe',
        facturaPin: 'pin-fe',
        facturaTestSetId: 'ts-fe',
        nominaSoftwareId: 'sw-ne',
        nominaPin: 'pin-ne',
        nominaTestSetId: 'ts-ne',
        certPath: 'certs/a.p12',
        certVenceAt: new Date('2099-01-01'),
        certTitular: 'Crunchy SAS',
        certPassword: 'clave-p12',
      });
      const guardado = emisores.get(e.id);
      // Lo no secreto va en claro; lo secreto, solo cifrado.
      expect(guardado.facturaSoftwareId).toBe('sw-fe');
      expect(guardado.nominaTestSetId).toBe('ts-ne');
      expect(JSON.stringify(guardado)).not.toMatch(/pin-fe|pin-ne|clave-p12/);

      expect(descifrar(guardado.facturaPin, contextoSecreto(e.id, 'facturaPin'))).toBe('pin-fe');
      expect(await svc.leerSecreto(e.id, 'nominaPin')).toBe('pin-ne');
      expect(await svc.leerSecreto(e.id, 'certPasswordCifrada')).toBe('clave-p12');
    });

    it('no descifra con otro campo ni con otro emisor', async () => {
      const e = await svc.asegurarParaSede(nuevaSede());
      await svc.guardarCredenciales(e.id, { facturaPin: 'pin-fe' });
      const valor = emisores.get(e.id).facturaPin;
      expect(() => descifrar(valor, contextoSecreto(e.id, 'nominaPin'))).toThrow(SecretoIlegibleError);
      const otro = new Types.ObjectId().toString();
      expect(() => descifrar(valor, contextoSecreto(otro, 'facturaPin'))).toThrow(SecretoIlegibleError);
    });

    it('sin llave lanza y no guarda nada, ni siquiera lo no secreto', async () => {
      const e = await svc.asegurarParaSede(nuevaSede());
      delete process.env[VARIABLE_LLAVE];
      await expect(
        svc.guardarCredenciales(e.id, { facturaSoftwareId: 'sw', facturaPin: 'pin' }),
      ).rejects.toThrow(/no está configurada/);
      expect(emisores.get(e.id).facturaSoftwareId).toBeUndefined();
      expect(model.updateOne).not.toHaveBeenCalled();
    });

    it('sin cambios no escribe; emisor inexistente es 404', async () => {
      const e = await svc.asegurarParaSede(nuevaSede());
      await svc.guardarCredenciales(e.id, {});
      expect(model.updateOne).not.toHaveBeenCalled();
      await expect(
        svc.guardarCredenciales(new Types.ObjectId().toString(), { facturaPin: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.leerSecreto('malo', 'facturaPin')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('leerSecreto rechaza un campo que no es secreto', async () => {
      const e = await svc.asegurarParaSede(nuevaSede());
      await expect(svc.leerSecreto(e.id, 'nit' as never)).rejects.toThrow('Campo secreto desconocido');
    });

    it('un secreto no guardado se lee como null', async () => {
      const e = await svc.asegurarParaSede(nuevaSede());
      expect(await svc.leerSecreto(e.id, 'facturaPin')).toBeNull();
    });
  });

  describe('estadoConfiguracion, transmisor y vista', () => {
    it('dice qué falta y el transmisor sigue siendo el stub', async () => {
      const s = nuevaSede();
      const e = await svc.asegurarParaSede(s);
      const antes = await svc.estadoConfiguracion(e.id);
      expect(antes).toMatchObject({ certificadoVigente: false, tienePin: false, habilitado: false });
      expect(antes.faltaParaTransmitir).toHaveLength(3);

      await svc.guardarCredenciales(e.id, {
        facturaSoftwareId: 'sw',
        facturaPin: 'pin',
        certPath: 'c.p12',
        certVenceAt: new Date('2099-01-01'),
        certPassword: 'p',
      });
      const despues = await svc.estadoConfiguracion(e.id);
      expect(despues).toMatchObject({ certificadoVigente: true, softwareId: 'sw', tienePin: true });
      expect(despues.faltaParaTransmitir).toEqual([]);

      const t = await svc.transmisorParaSede(s);
      expect(t).toBeInstanceOf(StubDian);
      expect((await t.enviar({ tipo: 'invoice', fullNumber: 'FE1' })).mensajes[0]).toContain(
        'aún no implementada',
      );
    });

    it('sede sin emisor: stub que lo dice', async () => {
      const t = await svc.transmisorParaSede(nuevaSede());
      expect((await t.enviar({ tipo: 'invoice', fullNumber: 'FE1' })).mensajes[0]).toContain(
        'no tiene emisor',
      );
    });

    it('la vista solo trae booleanos de los secretos y respeta el alcance de sedes', async () => {
      const s = nuevaSede();
      const e = await svc.asegurarParaSede(s);
      await svc.guardarCredenciales(e.id, { facturaPin: 'pin-fe', certPassword: 'clave-p12' });
      const user = { role: 'owner', permissions: [], sedeIds: [s] } as unknown as JwtUser;
      const r = await svc.vistaDeSede(s, user);
      expect(r.emisor).toMatchObject({ tieneFacturaPin: true, tieneNominaPin: false, tieneCertificado: false });
      const json = JSON.stringify(r);
      expect(json).not.toMatch(/pin-fe|clave-p12|"iv"|"tag"/);
      expect(Object.keys(r.emisor!)).not.toContain('facturaPin');

      const otraSede = nuevaSede();
      expect(await svc.vistaDeSede(otraSede, { ...user, sedeIds: [otraSede] } as JwtUser)).toEqual({
        emisor: null,
        estado: null,
      });

      const cajero = { role: 'cashier', permissions: [], sedeIds: [otraSede] } as unknown as JwtUser;
      await expect(svc.vistaDeSede(s, cajero)).rejects.toThrow('No tienes acceso');
    });
  });
});
