import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';

// Mismo patrón que `password-reset.service.spec.ts`: modelos mockeados y
// decoradores de Mongoose neutralizados para poder importar el servicio.
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

import { RegistrationService } from './registration.service';
import type { RegisterDto } from './dto/register.dto';

/**
 * Ítem 4.11: el registro no debe servir para averiguar qué correos tienen
 * cuenta. Antes respondía 409 «El correo ya está registrado»; ahora los dos
 * caminos devuelven lo mismo y la diferencia solo llega al buzón.
 */
const DTO = {
  businessName: 'Panadería Prueba',
  plan: 'negocio',
  tipoNegocio: 'restaurante',
  ownerName: 'Dueña Prueba',
  ownerEmail: 'Duena@Ejemplo.com',
  password: 'ClaveFicticia#2026',
} as unknown as RegisterDto;

const exec = <T>(v: T) => ({ exec: vi.fn().mockResolvedValue(v) });

function makeDeps() {
  const pendientes = {
    findOne: vi.fn().mockReturnValue(exec(null)),
    findOneAndUpdate: vi.fn().mockReturnValue(exec(null)),
    updateOne: vi.fn().mockReturnValue(exec(undefined)),
    deleteOne: vi.fn().mockReturnValue(exec(undefined)),
    deleteMany: vi.fn().mockReturnValue(exec(undefined)),
    create: vi.fn().mockResolvedValue({}),
  };
  const directory = {
    exists: vi.fn().mockResolvedValue(false),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
  const businesses = {
    nitExists: vi.fn().mockResolvedValue(false),
    remove: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({
      id: '64b000000000000000000001',
      dbName: 'biz_64b000000000000000000001',
      plan: 'negocio',
      tipoNegocio: 'restaurante',
    }),
  };
  const roles = { ensureSystemRoles: vi.fn().mockResolvedValue(undefined) };
  const sedes = { create: vi.fn().mockResolvedValue({ id: 'sede1' }) };
  const users = { create: vi.fn().mockResolvedValue({ id: 'u1' }) };
  const auth = {
    issueSession: vi.fn().mockResolvedValue({
      tokens: { accessToken: 'a', refreshToken: 'r' },
      user: { id: 'u1' },
    }),
  };
  const mail = {
    sendConfirmacionRegistro: vi.fn().mockResolvedValue({ sent: true }),
    sendAvisoCuentaExistente: vi.fn().mockResolvedValue({ sent: true }),
  };
  const config = { get: vi.fn().mockReturnValue('https://app.ejemplo.test/') };
  return { pendientes, directory, businesses, roles, sedes, users, auth, mail, config };
}

function makeService(d: ReturnType<typeof makeDeps>) {
  return new RegistrationService(
    d.businesses as never,
    d.directory as never,
    d.roles as never,
    d.sedes as never,
    d.users as never,
    d.auth as never,
    d.pendientes as never,
    d.mail as never,
    d.config as never,
  );
}

describe('RegistrationService · sin oráculo de correos (ítem 4.11)', () => {
  let d: ReturnType<typeof makeDeps>;
  let service: RegistrationService;

  beforeEach(() => {
    d = makeDeps();
    service = makeService(d);
  });

  it('correo nuevo: no crea la empresa, guarda solo hashes y envía el enlace', async () => {
    await expect(service.solicitar(DTO)).resolves.toBeUndefined();

    expect(d.businesses.create).not.toHaveBeenCalled();
    const [filtro, update] = d.pendientes.findOneAndUpdate.mock.calls[0]!;
    expect(filtro).toEqual({ email: 'duena@ejemplo.com', tipo: 'confirmacion' });
    const doc = update.$set;
    expect(JSON.stringify(doc)).not.toContain(DTO.password);
    expect(doc.passwordHash).toMatch(/^\$2[aby]\$/);

    const mail = d.mail.sendConfirmacionRegistro.mock.calls[0]![0];
    const token = mail.confirmUrl.split('/registro/confirmar/')[1];
    expect(mail.confirmUrl.startsWith('https://app.ejemplo.test/registro/confirmar/')).toBe(true);
    expect(doc.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(d.mail.sendAvisoCuentaExistente).not.toHaveBeenCalled();
  });

  it('correo ya registrado: misma respuesta, sin error, y aviso al dueño del buzón', async () => {
    d.directory.exists.mockResolvedValue(true);

    // Antes: ConflictException «El correo ya está registrado».
    await expect(service.solicitar(DTO)).resolves.toBeUndefined();

    expect(d.mail.sendAvisoCuentaExistente).toHaveBeenCalledWith({
      to: 'duena@ejemplo.com',
      loginUrl: 'https://app.ejemplo.test/login',
      recoverUrl: 'https://app.ejemplo.test/recuperar',
    });
    expect(d.mail.sendConfirmacionRegistro).not.toHaveBeenCalled();
    expect(d.businesses.create).not.toHaveBeenCalled();
  });

  it('el NIT repetido tampoco se revela al pedir el alta', async () => {
    d.businesses.nitExists.mockResolvedValue(true);
    await expect(
      service.solicitar({ ...DTO, nit: '900123456' } as RegisterDto),
    ).resolves.toBeUndefined();
    expect(d.mail.sendConfirmacionRegistro).toHaveBeenCalled();
  });

  it('antiflood: dentro del enfriamiento no manda otro correo', async () => {
    d.pendientes.findOne.mockReturnValue(
      exec({ email: 'duena@ejemplo.com', ultimoEnvioAt: new Date() }),
    );
    await expect(service.solicitar(DTO)).resolves.toBeUndefined();
    expect(d.mail.sendConfirmacionRegistro).not.toHaveBeenCalled();
    expect(d.mail.sendAvisoCuentaExistente).not.toHaveBeenCalled();
  });

  it('confirmar: consume el enlace una sola vez y crea la empresa con el hash guardado', async () => {
    d.pendientes.findOneAndUpdate.mockReturnValue(
      exec({
        _id: 'p1',
        email: 'duena@ejemplo.com',
        passwordHash: '$2a$10$hashficticio',
        datos: { ...DTO, ownerEmail: 'duena@ejemplo.com', password: undefined },
      }),
    );
    const out = await service.confirmar('tok');

    const filtro = d.pendientes.findOneAndUpdate.mock.calls[0]![0];
    expect(filtro.tokenHash).toBe(createHash('sha256').update('tok').digest('hex'));
    expect(filtro.tipo).toBe('confirmacion');
    expect(filtro.expiresAt.$gt).toBeInstanceOf(Date);
    expect(d.users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'duena@ejemplo.com', role: 'owner' }),
      undefined,
      { passwordHash: '$2a$10$hashficticio' },
    );
    expect(out.plan).toBe('negocio');
  });

  it('confirmar: enlace inexistente, usado o vencido → 404 sin crear nada', async () => {
    await expect(service.confirmar('otro')).rejects.toBeInstanceOf(NotFoundException);
    expect(d.businesses.create).not.toHaveBeenCalled();
  });

  it('confirmar: si el correo se ocupó mientras tanto, se le dice al dueño del buzón', async () => {
    d.pendientes.findOneAndUpdate.mockReturnValue(
      exec({ _id: 'p1', email: 'duena@ejemplo.com', passwordHash: 'h', datos: { ...DTO } }),
    );
    d.directory.exists.mockResolvedValue(true);
    await expect(service.confirmar('tok')).rejects.toBeInstanceOf(ConflictException);
    expect(d.businesses.create).not.toHaveBeenCalled();
  });
});
