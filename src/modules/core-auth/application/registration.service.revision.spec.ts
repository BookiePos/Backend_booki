import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';

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
 * Ítem 4.11, revisión 2: correo que no sale, reenvío, reclamo atómico del
 * pendiente y compensación de la empresa a medias.
 */
const DTO = {
  businessName: 'Panadería Prueba',
  plan: 'negocio',
  tipoNegocio: 'restaurante',
  ownerName: 'Dueña Prueba',
  ownerEmail: 'duena@ejemplo.com',
  password: 'ClaveFicticia#2026',
} as unknown as RegisterDto;

const exec = <T>(v: T) => ({
  exec: vi.fn().mockResolvedValue(v),
});

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
      id: 'biz1',
      dbName: 'biz_biz1',
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
  const config = { get: vi.fn().mockReturnValue('https://app.ejemplo.test') };
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

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

describe('RegistrationService · correo que no sale (4.11 rev. 2)', () => {
  let d: ReturnType<typeof makeDeps>;
  let service: RegistrationService;
  let logError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    d = makeDeps();
    service = makeService(d);
    logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('correo nuevo: si el proveedor falla responde 503, sin token en el log, y el pendiente queda', async () => {
    d.mail.sendConfirmacionRegistro.mockResolvedValue({ sent: false, error: 'boom' });
    const err = await service.solicitar(DTO).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe('Registro no disponible temporalmente');
    expect(d.pendientes.findOneAndUpdate).toHaveBeenCalled();
    expect(d.pendientes.deleteMany).not.toHaveBeenCalled();
    expect(d.pendientes.deleteOne).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
    const token = d.mail.sendConfirmacionRegistro.mock.calls[0]![0].confirmUrl.split('/').pop();
    const logs = logError.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logs).not.toContain(token);
    expect(JSON.stringify(err.getResponse())).not.toContain(token);
  });

  it('cuenta existente: mismo 503 y mismo mensaje, con el pendiente vigente', async () => {
    d.directory.exists.mockResolvedValue(true);
    d.mail.sendAvisoCuentaExistente.mockResolvedValue({ sent: false, error: 'boom' });
    const err = await service.solicitar(DTO).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe('Registro no disponible temporalmente');
    expect(d.pendientes.create).toHaveBeenCalled();
    expect(d.pendientes.deleteOne).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });

  it('fuera de producción el correo simulado cuenta como enviado', async () => {
    d.mail.sendConfirmacionRegistro.mockResolvedValue({ sent: false, simulated: true });
    await expect(service.solicitar(DTO)).resolves.toBeUndefined();
  });
});

describe('RegistrationService · un solo enlace vivo (4.11 rev. 2)', () => {
  it('solicitar reemplaza el token del mismo correo con un upsert, no crea otro pendiente', async () => {
    const d = makeDeps();
    await makeService(d).solicitar(DTO);
    const [filtro, update, opts] = d.pendientes.findOneAndUpdate.mock.calls[0]!;
    expect(filtro).toEqual({ email: 'duena@ejemplo.com', tipo: 'confirmacion' });
    expect(opts).toEqual({ upsert: true });
    expect(update.$set.envios).toBe(1);
    expect(d.pendientes.create).not.toHaveBeenCalled();
  });

  it('una carrera perdida contra el índice único (11000) no es un error', async () => {
    const d = makeDeps();
    d.pendientes.findOneAndUpdate.mockReturnValue({
      exec: vi.fn().mockRejectedValue({ code: 11000 }),
    });
    await expect(makeService(d).solicitar(DTO)).resolves.toBeUndefined();
    expect(d.mail.sendConfirmacionRegistro).not.toHaveBeenCalled();
  });

  it('con 5 envíos en el día no manda otro', async () => {
    const d = makeDeps();
    d.pendientes.findOne
      .mockReturnValueOnce(exec(null)) // enfriamiento
      .mockReturnValueOnce(exec({ envios: 5, envioDiaInicio: new Date() }));
    await makeService(d).solicitar(DTO);
    expect(d.mail.sendConfirmacionRegistro).not.toHaveBeenCalled();
    expect(d.pendientes.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('RegistrationService · reenviar (4.11 rev. 2)', () => {
  const vigente = (extra: Record<string, unknown> = {}) => ({
    _id: 'p1',
    email: 'duena@ejemplo.com',
    tokenHash: hash('viejo'),
    datos: { businessName: 'Panadería Prueba' },
    expiresAt: new Date(Date.now() + 5 * 3_600_000),
    envios: 1,
    envioDiaInicio: new Date(Date.now() - 3_600_000),
    ultimoEnvioAt: new Date(Date.now() - 120_000),
    ...extra,
  });

  it('manda un token nuevo y el anterior queda inválido', async () => {
    const d = makeDeps();
    d.pendientes.findOne.mockReturnValue(exec(vigente()));
    d.pendientes.findOneAndUpdate.mockReturnValue(exec({ _id: 'p1' }));
    await expect(makeService(d).reenviar(' Duena@Ejemplo.com ')).resolves.toBeUndefined();

    const [filtro, update] = d.pendientes.findOneAndUpdate.mock.calls[0]!;
    expect(filtro).toEqual({ _id: 'p1', tokenHash: hash('viejo') });
    const mail = d.mail.sendConfirmacionRegistro.mock.calls[0]![0];
    const token = mail.confirmUrl.split('/registro/confirmar/')[1];
    expect(update.$set.tokenHash).toBe(hash(token));
    expect(update.$set.tokenHash).not.toBe(hash('viejo'));
    expect(update.$set.envios).toBe(2);
    expect(mail.to).toBe('duena@ejemplo.com');
    expect(mail.expiresHours).toBe(5);
  });

  it('sin pendiente responde igual y no envía nada', async () => {
    const d = makeDeps();
    await expect(makeService(d).reenviar('nadie@ejemplo.com')).resolves.toBeUndefined();
    expect(d.mail.sendConfirmacionRegistro).not.toHaveBeenCalled();
  });

  it('1 por minuto: dentro del enfriamiento no envía', async () => {
    const d = makeDeps();
    d.pendientes.findOne.mockReturnValue(exec(vigente({ ultimoEnvioAt: new Date() })));
    await makeService(d).reenviar('duena@ejemplo.com');
    expect(d.mail.sendConfirmacionRegistro).not.toHaveBeenCalled();
    expect(d.pendientes.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('5 por día: el sexto no envía; pasadas 24 h la cuenta vuelve a cero', async () => {
    const d = makeDeps();
    d.pendientes.findOne.mockReturnValue(exec(vigente({ envios: 5 })));
    await makeService(d).reenviar('duena@ejemplo.com');
    expect(d.mail.sendConfirmacionRegistro).not.toHaveBeenCalled();

    d.pendientes.findOne.mockReturnValue(
      exec(vigente({ envios: 5, envioDiaInicio: new Date(Date.now() - 25 * 3_600_000) })),
    );
    d.pendientes.findOneAndUpdate.mockReturnValue(exec({ _id: 'p1' }));
    await makeService(d).reenviar('duena@ejemplo.com');
    expect(d.mail.sendConfirmacionRegistro).toHaveBeenCalledTimes(1);
    expect(d.pendientes.findOneAndUpdate.mock.calls[0]![1].$set.envios).toBe(1);
  });

  it('dos reenvíos a la vez: el que pierde la condición del token no envía', async () => {
    const d = makeDeps();
    d.pendientes.findOne.mockReturnValue(exec(vigente()));
    await makeService(d).reenviar('duena@ejemplo.com'); // findOneAndUpdate → null
    expect(d.mail.sendConfirmacionRegistro).not.toHaveBeenCalled();
  });

  it('si el correo no sale responde 503', async () => {
    const d = makeDeps();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    d.pendientes.findOne.mockReturnValue(exec(vigente()));
    d.pendientes.findOneAndUpdate.mockReturnValue(exec({ _id: 'p1' }));
    d.mail.sendConfirmacionRegistro.mockResolvedValue({ sent: false, error: 'x' });
    await expect(makeService(d).reenviar('duena@ejemplo.com')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('RegistrationService · confirmar reclama, no borra primero (4.11 rev. 2)', () => {
  const reclamado = {
    _id: 'p1',
    email: 'duena@ejemplo.com',
    passwordHash: '$2a$10$hashficticio',
    datos: { ...DTO, ownerEmail: 'duena@ejemplo.com', password: undefined },
  };

  it('reclama con consumiendoAt que vence y borra el pendiente solo al terminar bien', async () => {
    const d = makeDeps();
    d.pendientes.findOneAndUpdate.mockReturnValue(exec(reclamado));
    await makeService(d).confirmar('tok');

    const [filtro, update, opts] = d.pendientes.findOneAndUpdate.mock.calls[0]!;
    expect(filtro.tokenHash).toBe(hash('tok'));
    expect(filtro.$or).toEqual(
      expect.arrayContaining([{ consumiendoAt: { $lt: expect.any(Date) } }]),
    );
    expect(update.$set.consumiendoAt).toBeInstanceOf(Date);
    expect(opts).toEqual({ new: true });
    expect(d.pendientes.deleteOne).toHaveBeenCalledWith({ _id: 'p1', tokenHash: hash('tok') });
  });

  it('si falla la creación: deshace la empresa, suelta la marca y no borra el pendiente', async () => {
    const d = makeDeps();
    d.pendientes.findOneAndUpdate.mockReturnValue(exec(reclamado));
    d.sedes.create.mockRejectedValue(new Error('mongo caído'));
    await expect(makeService(d).confirmar('tok')).rejects.toThrow('mongo caído');

    expect(d.directory.unlink).toHaveBeenCalledWith('duena@ejemplo.com', 'biz1');
    expect(d.businesses.remove).toHaveBeenCalledWith('biz1');
    expect(d.pendientes.updateOne).toHaveBeenCalledWith(
      { _id: 'p1' },
      { $unset: { consumiendoAt: 1 } },
    );
    expect(d.pendientes.deleteOne).not.toHaveBeenCalled();
  });

  it('un conflicto (correo ocupado) también suelta la marca', async () => {
    const d = makeDeps();
    d.pendientes.findOneAndUpdate.mockReturnValue(exec(reclamado));
    d.directory.exists.mockResolvedValue(true);
    await expect(makeService(d).confirmar('tok')).rejects.toBeInstanceOf(ConflictException);
    expect(d.pendientes.updateOne).toHaveBeenCalled();
    expect(d.businesses.create).not.toHaveBeenCalled();
  });
});
