import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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

import { CertificadoEmisorService, CERT_MAX_BYTES } from './certificado-emisor.service';
import { FiscalEmittersService } from './fiscal-emitters.service';
import { EinvoicingController } from '../infrastructure/einvoicing.controller';
import { LlaveCifradoInterceptor } from '../infrastructure/llave-cifrado.interceptor';
import { PermissionsGuard } from '../../core-auth/infrastructure/guards/permissions.guard';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { SYSTEM_ROLES, ROLES } from '../../core-auth/domain/roles';
import { contextoSecreto, descifrar, VARIABLE_LLAVE } from '../../../shared/crypto/secretos';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { p12DePrueba } from '../domain/p12-de-prueba.test';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

// node-forge abre y cifra .p12 en JS puro: con la máquina cargada (la suite
// completa en paralelo) un test pasa de los 5 s por defecto sin estar colgado.
vi.setConfig({ testTimeout: 30_000 });

const PASS = 'clave-de-prueba';
const DIA = 86_400_000;

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

describe('CertificadoEmisorService.cargar', () => {
  const llaveAnterior = process.env[VARIABLE_LLAVE];
  let emisor: any;
  let sedeId: string;
  let model: any;
  let storage: any;
  let audit: any;
  let bucket: Map<string, Buffer>;
  let fiscal: FiscalEmittersService;
  let svc: CertificadoEmisorService;
  const dueno = { userId: 'u1', email: 'd@x.co', name: 'Dueña', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;

  const archivo = (buffer: Buffer, originalname = 'firma.p12') => ({ buffer, size: buffer.length, originalname });
  const enEmpresa = <T>(fn: () => Promise<T>) => TenantContext.run({ businessId: 'biz1', dbName: 'biz_biz1' }, fn);

  beforeEach(() => {
    process.env[VARIABLE_LLAVE] = randomBytes(32).toString('base64');
    sedeId = String(new Types.ObjectId());
    emisor = doc({ _id: new Types.ObjectId(), nit: '900.123.456-8', nitNorm: '900123456', tipoAmbiente: '2', habilitado: false });
    model = {
      findById: vi.fn(() => chain(emisor)),
      updateOne: vi.fn((f: any, u: any) => {
        const actual = emisor.certPath ?? null;
        if (String(f._id) !== emisor.id || ('certPath' in f && f.certPath !== actual)) {
          return chain({ matchedCount: 0 });
        }
        Object.assign(emisor, u.$set);
        for (const k of Object.keys(u.$unset ?? {})) delete emisor[k];
        return chain({ matchedCount: 1 });
      }),
    };
    bucket = new Map();
    storage = {
      assertDisponible: vi.fn(),
      guardarCertificado: vi.fn(async (id: string, nombre: string, b: Buffer) => {
        const pathname = `einvoicing/biz1/${id}/cert/${nombre}`;
        bucket.set(pathname, b);
        return { pathname };
      }),
      leerCertificado: vi.fn(async (id: string, nombre: string) => bucket.get(`einvoicing/biz1/${id}/cert/${nombre}`)),
      borrarCertificado: vi.fn(async (id: string, nombre: string) => {
        bucket.delete(`einvoicing/biz1/${id}/cert/${nombre}`);
      }),
    };
    audit = { record: vi.fn(async () => undefined) };
    fiscal = new FiscalEmittersService(model, {} as never, storage, audit);
    vi.spyOn(fiscal, 'asegurarParaSede').mockImplementation(async () => emisor);
    vi.spyOn(fiscal, 'vistaDeSede').mockImplementation(async () => ({ emisor: fiscal.vista(emisor), estado: null }));
    svc = new CertificadoEmisorService(model, fiscal, storage, audit, {} as never);
  });

  afterEach(() => {
    if (llaveAnterior === undefined) delete process.env[VARIABLE_LLAVE];
    else process.env[VARIABLE_LLAVE] = llaveAnterior;
  });

  it('sin EINVOICING_ENCRYPTION_KEY responde 503 y no sube nada', async () => {
    delete process.env[VARIABLE_LLAVE];
    const err = await svc.cargar(sedeId, archivo(p12DePrueba()), PASS, dueno).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toMatch(/EINVOICING_ENCRYPTION_KEY/);
    expect(storage.guardarCertificado).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('el interceptor corta con 503 antes de que multer lea el archivo', () => {
    delete process.env[VARIABLE_LLAVE];
    const next = { handle: vi.fn() };
    expect(() => new LlaveCifradoInterceptor().intercept({} as never, next)).toThrow(ServiceUnavailableException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('carga un .p12 válido: bucket, contraseña cifrada, metadata y auditoría', async () => {
    const r = await enEmpresa(() => svc.cargar(sedeId, archivo(p12DePrueba()), PASS, dueno, '1.2.3.4'));
    expect(r.reemplazado).toBe(false);
    expect(bucket.size).toBe(1);
    expect(emisor.certPath).toMatch(new RegExp(`^einvoicing/biz1/${emisor.id}/cert/cert-\\d{8}-\\d{6}-[0-9a-f]{12}-[0-9a-f]{8}\\.p12$`));
    expect(emisor.certTitular).toBe('CRUNCHY PRUEBAS SAS');
    expect(emisor.certHuella).toMatch(/^[0-9a-f]{64}$/);
    expect(emisor.certVenceAt).toBeInstanceOf(Date);
    // Contexto de FiscalEmittersService: `<emisorId>:certPasswordCifrada`.
    expect(descifrar(emisor.certPasswordCifrada, contextoSecreto(emisor.id, 'certPasswordCifrada'))).toBe(PASS);
    expect(JSON.stringify(emisor.certPasswordCifrada)).not.toContain(PASS);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const rec = audit.record.mock.calls[0][0];
    expect(rec).toMatchObject({ userId: 'u1', action: 'einvoicing.certificado.cargado', ip: '1.2.3.4' });
    expect(rec.detail.huella).toBe(emisor.certHuella);
    expect(JSON.stringify(rec)).not.toContain(PASS);

    expect(r.emisor).toMatchObject({ certificadoVigente: true, certAviso: null, tieneCertificado: true });
    expect(JSON.stringify(r)).not.toContain(PASS);
    expect(JSON.stringify(r)).not.toContain('certPasswordCifrada');
  });

  it.each([
    ['contraseña mala', () => p12DePrueba(), 'mala', /contraseña/],
    ['vencido', () => p12DePrueba({ desde: new Date(Date.now() - 400 * DIA), hasta: new Date(Date.now() - DIA) }), PASS, /vencido/],
    ['autofirmado', () => p12DePrueba({ autofirmado: true }), PASS, /autofirmado/],
    ['otro NIT', () => p12DePrueba({ nit: '800999888' }), PASS, /NIT/],
    ['SHA-1', () => p12DePrueba({ sha1: true }), PASS, /SHA-1/],
  ])('rechaza (%s) con 400 sin subir nada', async (_n, p12, pass, msg) => {
    const err = await enEmpresa(() => svc.cargar(sedeId, archivo(p12()), pass, dueno)).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(msg);
    expect(storage.guardarCertificado).not.toHaveBeenCalled();
    expect(emisor.certPath).toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rechaza archivo vacío, de otra extensión o de más de 50 KB', async () => {
    await expect(svc.cargar(sedeId, undefined, PASS, dueno)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.cargar(sedeId, archivo(p12DePrueba(), 'firma.pem'), PASS, dueno)).rejects.toThrow(/\.p12 o \.pfx/);
    const grande = Buffer.alloc(CERT_MAX_BYTES + 1);
    await expect(svc.cargar(sedeId, archivo(grande), PASS, dueno)).rejects.toThrow(/50 KB/);
    await expect(svc.cargar(sedeId, archivo(p12DePrueba()), '', dueno)).rejects.toThrow(/contraseña/);
  });

  it('respeta el alcance de sedes', async () => {
    const admin = { userId: 'u2', role: 'admin', permissions: [], sedeIds: ['otra'] } as unknown as JwtUser;
    await expect(svc.cargar(sedeId, archivo(p12DePrueba()), PASS, admin)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reemplazo: el anterior sigue si el nuevo no valida', async () => {
    await enEmpresa(() => svc.cargar(sedeId, archivo(p12DePrueba()), PASS, dueno));
    const antes = { path: emisor.certPath, huella: emisor.certHuella, pass: emisor.certPasswordCifrada };
    await expect(
      enEmpresa(() => svc.cargar(sedeId, archivo(p12DePrueba({ sha1: true })), PASS, dueno)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(emisor.certPath).toBe(antes.path);
    expect(emisor.certHuella).toBe(antes.huella);
    expect(emisor.certPasswordCifrada).toBe(antes.pass);
    expect(bucket.has(antes.path)).toBe(true);
  });

  it('reemplazo: el nuevo entra, el anterior se borra del bucket y queda en la auditoría', async () => {
    await enEmpresa(() => svc.cargar(sedeId, archivo(p12DePrueba()), PASS, dueno, undefined, new Date()));
    const anterior = { path: emisor.certPath as string, huella: emisor.certHuella as string };
    const otroMomento = new Date(Date.now() + 5000);
    const r = await enEmpresa(() =>
      svc.cargar(sedeId, archivo(p12DePrueba({ password: 'nueva', keyUsage: { nonRepudiation: true } })), 'nueva', dueno, undefined, otroMomento),
    );
    expect(r.reemplazado).toBe(true);
    expect(emisor.certPath).not.toBe(anterior.path);
    expect(bucket.has(anterior.path)).toBe(false);
    expect(bucket.has(emisor.certPath)).toBe(true);
    expect(descifrar(emisor.certPasswordCifrada, contextoSecreto(emisor.id, 'certPasswordCifrada'))).toBe('nueva');
    const rec = audit.record.mock.calls[1][0];
    expect(rec.action).toBe('einvoicing.certificado.reemplazado');
    expect(rec.detail).toMatchObject({ huella: emisor.certHuella, huellaAnterior: anterior.huella });
    expect(JSON.stringify(rec)).not.toMatch(/nueva|clave-de-prueba/);
  });

  it('si otra carga ganó la carrera, responde 409 y borra su propio archivo', async () => {
    model.updateOne.mockImplementationOnce(() => chain({ matchedCount: 0 }));
    await expect(enEmpresa(() => svc.cargar(sedeId, archivo(p12DePrueba()), PASS, dueno))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(bucket.size).toBe(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('doble carga simultánea del mismo .p12: queda una, y la que pierde no borra la vigente', async () => {
    // Cada carga ve el emisor como estaba al empezar (dos peticiones).
    vi.mocked(fiscal.asegurarParaSede).mockImplementation(async () => ({ ...emisor }));
    const p12 = p12DePrueba();
    const ahora = new Date();
    const r = await enEmpresa(() =>
      Promise.allSettled([
        svc.cargar(sedeId, archivo(p12), PASS, dueno, undefined, ahora),
        svc.cargar(sedeId, archivo(p12), PASS, dueno, undefined, ahora),
      ]),
    );
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    const perdida = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(perdida.reason).toBeInstanceOf(ConflictException);
    // Rutas distintas aunque sea el mismo archivo en el mismo segundo.
    const subidas = storage.guardarCertificado.mock.calls.map((c: any[]) => c[1]);
    expect(new Set(subidas).size).toBe(2);
    // El bucket conserva justo el archivo al que apunta la base.
    expect([...bucket.keys()]).toEqual([emisor.certPath]);
  });

  it('si el updateOne falla pero la base ya apunta al archivo nuevo, no se borra', async () => {
    model.updateOne.mockImplementationOnce((f: any, u: any) => {
      Object.assign(emisor, u.$set);
      return { exec: () => Promise.reject(new Error('se cortó la respuesta')) };
    });
    await expect(enEmpresa(() => svc.cargar(sedeId, archivo(p12DePrueba()), PASS, dueno))).rejects.toThrow(
      'se cortó la respuesta',
    );
    expect(bucket.has(emisor.certPath)).toBe(true);
  });

  it('un certificado que vence en menos de 30 días entra con su aviso', async () => {
    const p12 = p12DePrueba({ hasta: new Date(Date.now() + 10 * DIA) });
    const r = await enEmpresa(() => svc.cargar(sedeId, archivo(p12), PASS, dueno));
    expect(emisor.certAviso).toBe('por-vencer');
    expect(r.emisor?.certAviso).toBe('por-vencer');
  });

  describe('FiscalEmittersService.cargarCertificado', () => {
    it('devuelve el .p12 y la contraseña, audita el uso y no se deja loguear', async () => {
      const p12 = p12DePrueba();
      await enEmpresa(() => svc.cargar(sedeId, archivo(p12), PASS, dueno));
      const cert = await enEmpresa(() => fiscal.cargarCertificado(emisor.id, 'factura'));
      expect(cert?.p12.equals(p12)).toBe(true);
      expect(cert?.password).toBe(PASS);
      expect(JSON.stringify({ cert })).not.toContain(PASS);
      expect(inspect(cert)).not.toContain(PASS);
      // Campos privados: ni el spread ni Object.entries/keys los exponen.
      expect({ ...cert }).toEqual({});
      expect(Object.entries(cert!)).toEqual([]);
      expect(Object.keys(cert!)).toEqual([]);
      expect(JSON.stringify({ ...cert })).not.toContain(PASS);
      const uso = audit.record.mock.calls.at(-1)[0];
      expect(uso).toMatchObject({ action: 'einvoicing.certificado.usado', detail: { huella: emisor.certHuella, motivo: 'factura' } });
      expect(JSON.stringify(uso)).not.toContain(PASS);
    });

    it('null sin certificado o sin llave', async () => {
      expect(await fiscal.cargarCertificado(emisor.id)).toBeNull();
      await enEmpresa(() => svc.cargar(sedeId, archivo(p12DePrueba()), PASS, dueno));
      delete process.env[VARIABLE_LLAVE];
      expect(await fiscal.cargarCertificado(emisor.id)).toBeNull();
    });
  });
});

describe('permisos de la carga del certificado', () => {
  const guard = new PermissionsGuard(new Reflector());
  const ctx = (permissions: string[]) =>
    ({
      getHandler: () => EinvoicingController.prototype.cargarCertificado,
      getClass: () => EinvoicingController,
      switchToHttp: () => ({ getRequest: () => ({ user: { permissions } }) }),
    }) as unknown as ExecutionContext;

  it('exige einvoicing.certificate', () => {
    expect(guard.canActivate(ctx([PERMISSIONS.EINVOICING_CERTIFICATE]))).toBe(true);
    expect(() => guard.canActivate(ctx([PERMISSIONS.EINVOICING_CONFIGURE, PERMISSIONS.EINVOICING_ISSUE]))).toThrow(
      ForbiddenException,
    );
  });

  it('de los roles de sistema solo el Dueño lo tiene', () => {
    const con = SYSTEM_ROLES.filter((r) => (r.permissions as string[]).includes(PERMISSIONS.EINVOICING_CERTIFICATE));
    expect(con.map((r) => r.key)).toEqual([ROLES.OWNER]);
  });
});

describe('CertificadoEmisorService.marcarAvisos', () => {
  it('marca por vencer y vencido, y quita el aviso que ya no aplica', async () => {
    const ahora = new Date('2026-10-30T00:00:00Z');
    const e = [
      { _id: 'a', certVenceAt: new Date(ahora.getTime() + 10 * DIA) },
      { _id: 'b', certVenceAt: new Date(ahora.getTime() - DIA) },
      { _id: 'c', certVenceAt: new Date(ahora.getTime() + 90 * DIA), certAviso: 'por-vencer' },
      { _id: 'd', certVenceAt: new Date(ahora.getTime() + 90 * DIA) },
    ];
    const model = { find: vi.fn(() => chain(e)), updateOne: vi.fn(() => chain({})) };
    const svc = new CertificadoEmisorService(model as never, {} as never, {} as never, {} as never, {} as never);
    expect(await svc.marcarAvisos(ahora)).toEqual({ porVencer: 1, vencidos: 1 });
    expect(model.updateOne).toHaveBeenCalledTimes(3);
    expect(model.updateOne).toHaveBeenCalledWith({ _id: 'a' }, { $set: { certAviso: 'por-vencer', certAvisoAt: ahora } });
    expect(model.updateOne).toHaveBeenCalledWith({ _id: 'b' }, { $set: { certAviso: 'vencido', certAvisoAt: ahora } });
    expect(model.updateOne).toHaveBeenCalledWith({ _id: 'c' }, { $unset: { certAviso: 1, certAvisoAt: 1 } });
  });

  it('el barrido recorre las empresas activas y reporta las cifras', async () => {
    const model = { find: vi.fn(() => chain([{ _id: 'a', certVenceAt: new Date(Date.now() + DIA) }])), updateOne: vi.fn(() => chain({})) };
    const businesses = { listActive: vi.fn(async () => [{ _id: 'b1', dbName: 'biz_b1' }, { _id: 'b2', dbName: 'biz_b2' }]) };
    const svc = new CertificadoEmisorService(model as never, {} as never, {} as never, {} as never, businesses as never);
    const r = await svc.barrerVencimientos();
    expect(r).toMatchObject({ estado: 'ok', cifras: { empresas: 2, procesadas: 2, porVencer: 2, vencidos: 0 } });
  });
});
