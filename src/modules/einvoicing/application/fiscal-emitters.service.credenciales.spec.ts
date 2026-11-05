import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
  cifrar,
  contextoSecreto,
  descifrar,
  SecretoIlegibleError,
  VARIABLE_LLAVE,
} from '../../../shared/crypto/secretos';
import { ConfigurarNominaDto } from './dto/configurar-nomina.dto';
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
  let storage: { leerCertificado: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };

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
      updateOne: vi.fn((f: { _id: unknown }, u: { $set?: Record<string, unknown>; $unset?: Record<string, ''> }) => {
        const e = emisores.get(String(f._id));
        Object.assign(e, u.$set);
        for (const k of Object.keys(u.$unset ?? {})) delete e[k];
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
    storage = { leerCertificado: vi.fn(async () => Buffer.from('p12')) };
    audit = { record: vi.fn(async () => undefined) };
    svc = new FiscalEmittersService(model, sedeModel, storage as never, audit as never);
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
      });
      const guardado = emisores.get(e.id);
      // Lo no secreto va en claro; lo secreto, solo cifrado.
      expect(guardado.facturaSoftwareId).toBe('sw-fe');
      expect(guardado.nominaTestSetId).toBe('ts-ne');
      expect(JSON.stringify(guardado)).not.toMatch(/pin-fe|pin-ne|clave-p12/);

      expect(descifrar(guardado.facturaPin, contextoSecreto(e.id, 'facturaPin'))).toBe('pin-fe');
      expect(await svc.leerSecreto(e.id, 'nominaPin')).toBe('pin-ne');
    });

    it('el certificado no entra por guardarCredenciales: solo por la carga validada', async () => {
      const e = await svc.asegurarParaSede(nuevaSede());
      await svc.guardarCredenciales(e.id, {
        facturaPin: 'pin',
        certPath: 'otra-empresa/x.p12',
        certPassword: 'clave-p12',
        certVenceAt: new Date('2099-01-01'),
      } as never);
      const guardado = emisores.get(e.id);
      expect(guardado.certPath).toBeUndefined();
      expect(guardado.certVenceAt).toBeUndefined();
      expect(guardado.certPasswordCifrada).toBeUndefined();
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

      await svc.guardarCredenciales(e.id, { facturaSoftwareId: 'sw', facturaPin: 'pin' });
      // El certificado lo deja `CertificadoEmisorService.cargar`; aquí se simula.
      Object.assign(emisores.get(e.id), {
        certPath: 'c.p12',
        certVenceAt: new Date('2099-01-01'),
        certPasswordCifrada: cifrar('p', contextoSecreto(e.id, 'certPasswordCifrada')),
      });
      const despues = await svc.estadoConfiguracion(e.id);
      expect(despues).toMatchObject({ certificadoVigente: true, softwareId: 'sw', tienePin: true });
      expect(despues.faltaParaTransmitir).toEqual([]);

      const t = await svc.transmisorParaSede(s);
      expect(t).toBeInstanceOf(StubDian);
      expect((await t.enviar({ tipo: 'invoice', fullNumber: 'FE1' })).mensajes[0]).toContain(
        'ambiente decidido por el gate',
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
      await svc.guardarCredenciales(e.id, { facturaPin: 'pin-fe' });
      emisores.get(e.id).certPasswordCifrada = cifrar('clave-p12', contextoSecreto(e.id, 'certPasswordCifrada'));
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

  describe('configurarNomina', () => {
    const UUID_SW = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const UUID_TS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const dueno = (s: string, role = 'owner') => ({ userId: 'u1', role, permissions: [], sedeIds: [s] }) as unknown as JwtUser;

    it('cifra el PIN con <emisorId>:nominaPin, audita sin secretos y no lo devuelve', async () => {
      const s = nuevaSede();
      const e = await svc.asegurarParaSede(s);
      const r = await svc.configurarNomina(s, { softwareId: UUID_SW, pin: 'pin-ne-123', testSetId: UUID_TS }, dueno(s), '1.2.3.4');
      const guardado = emisores.get(e.id);
      expect(guardado.nominaSoftwareId).toBe(UUID_SW);
      expect(guardado.nominaTestSetId).toBe(UUID_TS);
      expect(descifrar(guardado.nominaPin, contextoSecreto(e.id, 'nominaPin'))).toBe('pin-ne-123');
      expect(r.emisor).toMatchObject({ nominaConfigurada: true, tieneNominaPin: true, nominaSoftwareId: UUID_SW });
      expect(JSON.stringify(r)).not.toMatch(/pin-ne-123|"iv"|"tag"/);
      expect(Object.keys(r.emisor!)).not.toContain('nominaPin');
      const llamada = JSON.stringify(audit.record.mock.calls);
      expect(llamada).toContain('einvoicing.nomina.configurada');
      expect(llamada).not.toMatch(/pin-ne-123/);
    });

    it('sin llave de cifrado: 503 y no escribe nada', async () => {
      const s = nuevaSede();
      const e = await svc.asegurarParaSede(s);
      delete process.env[VARIABLE_LLAVE];
      await expect(
        svc.configurarNomina(s, { softwareId: UUID_SW, pin: 'pin-ne' }, dueno(s)),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(model.updateOne).not.toHaveBeenCalled();
      expect(emisores.get(e.id).nominaSoftwareId).toBeUndefined();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('llave de cifrado mal formada: 503 y no escribe nada', async () => {
      const s = nuevaSede();
      const e = await svc.asegurarParaSede(s);
      process.env[VARIABLE_LLAVE] = 'esto-no-es-una-llave';
      await expect(
        svc.configurarNomina(s, { softwareId: UUID_SW, pin: 'pin-ne' }, dueno(s)),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(model.updateOne).not.toHaveBeenCalled();
      expect(emisores.get(e.id).nominaSoftwareId).toBeUndefined();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('testSetId: null borra el que había sin tocar lo demás', async () => {
      const s = nuevaSede();
      const e = await svc.asegurarParaSede(s);
      await svc.configurarNomina(s, { softwareId: UUID_SW, pin: 'a', testSetId: UUID_TS }, dueno(s));
      const r = await svc.configurarNomina(s, { softwareId: UUID_SW, pin: 'b', testSetId: null }, dueno(s));
      expect(emisores.get(e.id).nominaTestSetId).toBeUndefined();
      expect(emisores.get(e.id).nominaSoftwareId).toBe(UUID_SW);
      expect(r.emisor).toMatchObject({ tieneNominaTestSetId: false, tieneNominaPin: true });
    });

    it('sede ajena: 403 sin tocar el emisor', async () => {
      const s = nuevaSede();
      await svc.asegurarParaSede(s);
      const otra = nuevaSede();
      await expect(
        svc.configurarNomina(s, { softwareId: UUID_SW, pin: 'pin-ne' }, dueno(otra, 'cashier')),
      ).rejects.toThrow('No tienes acceso');
      expect(model.updateOne).not.toHaveBeenCalled();
    });

    it('sede sin emisor: 400', async () => {
      const s = nuevaSede();
      await expect(
        svc.configurarNomina(s, { softwareId: UUID_SW, pin: 'pin-ne' }, dueno(s)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sin testSetId no pisa el que ya había', async () => {
      const s = nuevaSede();
      const e = await svc.asegurarParaSede(s);
      await svc.configurarNomina(s, { softwareId: UUID_SW, pin: 'a', testSetId: UUID_TS }, dueno(s));
      await svc.configurarNomina(s, { softwareId: UUID_SW, pin: 'b' }, dueno(s));
      expect(emisores.get(e.id).nominaTestSetId).toBe(UUID_TS);
      expect(JSON.stringify(audit.record.mock.calls)).toContain('einvoicing.nomina.actualizada');
    });
  });

  describe('configurarFactura', () => {
    const UUID_SW = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const UUID_TS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const dueno = (s: string) => ({ userId: 'u1', role: 'owner', permissions: [], sedeIds: [s] }) as unknown as JwtUser;

    it('cifra el PIN con <emisorId>:facturaPin, audita sin secretos y no lo devuelve', async () => {
      const s = nuevaSede();
      const e = await svc.asegurarParaSede(s);
      const r = await svc.configurarFactura(s, { softwareId: UUID_SW, pin: 'pin-fe-123', testSetId: UUID_TS }, dueno(s), '1.2.3.4');
      const guardado = emisores.get(e.id);
      expect(guardado.facturaSoftwareId).toBe(UUID_SW);
      expect(guardado.facturaTestSetId).toBe(UUID_TS);
      expect(descifrar(guardado.facturaPin, contextoSecreto(e.id, 'facturaPin'))).toBe('pin-fe-123');
      expect(r.emisor).toMatchObject({ tieneFacturaPin: true, tieneFacturaTestSetId: true, facturaSoftwareId: UUID_SW });
      expect(JSON.stringify(r)).not.toMatch(/pin-fe-123|"iv"|"tag"/);
      const llamada = JSON.stringify(audit.record.mock.calls);
      expect(llamada).toContain('einvoicing.factura.configurada');
      expect(llamada).not.toMatch(/pin-fe-123/);
    });

    it('sin llave de cifrado: 503 y no escribe nada', async () => {
      const s = nuevaSede();
      await svc.asegurarParaSede(s);
      delete process.env[VARIABLE_LLAVE];
      await expect(
        svc.configurarFactura(s, { softwareId: UUID_SW, pin: 'pin' }, dueno(s)),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(model.updateOne).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('testSetId: null borra el guardado y la sede sin emisor da 400', async () => {
      const s = nuevaSede();
      const e = await svc.asegurarParaSede(s);
      await svc.configurarFactura(s, { softwareId: UUID_SW, pin: 'a', testSetId: UUID_TS }, dueno(s));
      await svc.configurarFactura(s, { softwareId: UUID_SW, pin: 'b', testSetId: null }, dueno(s));
      expect(emisores.get(e.id).facturaTestSetId).toBeUndefined();
      expect(emisores.get(e.id).facturaSoftwareId).toBe(UUID_SW);
      const sin = nuevaSede();
      await expect(
        svc.configurarFactura(sin, { softwareId: UUID_SW, pin: 'x' }, dueno(sin)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('ConfigurarNominaDto', () => {
    const validar = async (o: object) =>
      (await validate(plainToInstance(ConfigurarNominaDto, o))).flatMap((x) => Object.keys(x.constraints ?? {}));

    it('acepta UUID + PIN y rechaza lo demás', async () => {
      const uuid = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
      expect(await validar({ softwareId: uuid, pin: 'x' })).toEqual([]);
      expect(await validar({ softwareId: uuid, pin: 'x', testSetId: uuid })).toEqual([]);
      expect((await validar({ softwareId: 'no-uuid', pin: 'x' })).length).toBeGreaterThan(0);
      expect((await validar({ softwareId: uuid, pin: '' })).length).toBeGreaterThan(0);
      expect((await validar({ softwareId: uuid })).length).toBeGreaterThan(0);
      expect((await validar({ softwareId: uuid, pin: 'x', testSetId: 'abc' })).length).toBeGreaterThan(0);
    });

    it('el PIN de solo espacios no pasa, y se recortan PIN, softwareId y testSetId', async () => {
      const uuid = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
      expect((await validar({ softwareId: uuid, pin: '    ' })).length).toBeGreaterThan(0);
      const dto = plainToInstance(ConfigurarNominaDto, { softwareId: ` ${uuid} `, pin: '  1234 ', testSetId: ` ${uuid}\n` });
      expect(await validate(dto)).toEqual([]);
      expect(dto).toMatchObject({ softwareId: uuid, pin: '1234', testSetId: uuid });
    });

    it('testSetId: null es válido (borra el guardado)', async () => {
      const uuid = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
      expect(await validar({ softwareId: uuid, pin: 'x', testSetId: null })).toEqual([]);
    });
  });
});
