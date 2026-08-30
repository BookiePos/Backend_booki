import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoneException, NotFoundException } from '@nestjs/common';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Aquí los modelos van
// mockeados, así que neutralizamos los decoradores para poder importar el
// servicio. Mismo patrón que `sales/application/orders.service.checkout.spec.ts`.
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

import { PasswordResetService } from './password-reset.service';

/**
 * Reglas del flujo de recuperación que no se pueden romper:
 * pedir un enlace nunca revela si la cuenta existe, y un enlace usado o vencido
 * no restablece nada.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (resets, directory, users, auth, mail, config).
 */
describe('PasswordResetService', () => {
  const entry = { businessId: 'b1', dbName: 'biz_b1' };

  function makeDeps() {
    const resets = {
      findOne: vi.fn(),
      deleteMany: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(undefined) }),
      create: vi.fn().mockResolvedValue({}),
    };
    const directory = {
      findByEmail: vi.fn().mockResolvedValue(null),
      findByUsername: vi.fn().mockResolvedValue(null),
    };
    const users = {
      findByEmail: vi.fn().mockResolvedValue(null),
      findByUsername: vi.fn().mockResolvedValue(null),
      findById: vi.fn(),
      setPassword: vi.fn().mockResolvedValue(undefined),
    };
    const auth = { revokeAllSessions: vi.fn().mockResolvedValue(undefined) };
    const mail = { sendPasswordReset: vi.fn().mockResolvedValue({ sent: true }) };
    const config = { get: vi.fn().mockReturnValue(undefined) };
    return { resets, directory, users, auth, mail, config };
  }

  function makeService(deps: ReturnType<typeof makeDeps>) {
    return new PasswordResetService(
      deps.resets as never,
      deps.directory as never,
      deps.users as never,
      deps.auth as never,
      deps.mail as never,
      deps.config as never,
    );
  }

  /** Cadena `findOne(...).sort(...).exec()` que usa el antiflood. */
  function pendingQuery(result: unknown) {
    return { sort: () => ({ exec: vi.fn().mockResolvedValue(result) }) };
  }

  let deps: ReturnType<typeof makeDeps>;
  let service: PasswordResetService;

  beforeEach(() => {
    deps = makeDeps();
    service = makeService(deps);
  });

  it('no lanza ni envía nada cuando el correo no está registrado', async () => {
    await expect(service.request('nadie@ejemplo.com')).resolves.toBeUndefined();
    expect(deps.mail.sendPasswordReset).not.toHaveBeenCalled();
    expect(deps.resets.create).not.toHaveBeenCalled();
  });

  it('envía el enlace y guarda solo el hash del token', async () => {
    deps.directory.findByEmail.mockResolvedValue(entry);
    deps.users.findByEmail.mockResolvedValue({
      id: 'u1',
      email: 'due@negocio.com',
      name: 'Dueña',
      active: true,
    });
    deps.resets.findOne.mockReturnValue(pendingQuery(null));

    await service.request('Due@Negocio.com ');

    const guardado = deps.resets.create.mock.calls[0][0] as {
      tokenHash: string;
      businessId: string;
      userId: string;
    };
    const enviado = deps.mail.sendPasswordReset.mock.calls[0][0] as {
      resetUrl: string;
    };
    const token = enviado.resetUrl.split('/recuperar/')[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // El token en claro va solo en el correo; en la base queda su SHA-256.
    expect(guardado.tokenHash).not.toBe(token);
    expect(guardado.businessId).toBe('b1');
    expect(guardado.userId).toBe('u1');
  });

  it('no manda correo a un usuario sin buzón real (@<empresa>.local)', async () => {
    deps.directory.findByUsername.mockResolvedValue(entry);
    deps.users.findByUsername.mockResolvedValue({
      id: 'u2',
      email: 'cajero@b1.local',
      name: 'Cajero',
      active: true,
    });

    await service.request('cajero');

    expect(deps.mail.sendPasswordReset).not.toHaveBeenCalled();
    expect(deps.resets.create).not.toHaveBeenCalled();
  });

  it('no manda correo a un usuario desactivado', async () => {
    deps.directory.findByEmail.mockResolvedValue(entry);
    deps.users.findByEmail.mockResolvedValue({
      id: 'u3',
      email: 'ex@negocio.com',
      name: 'Ex empleado',
      active: false,
    });

    await service.request('ex@negocio.com');

    expect(deps.mail.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('rechaza un token que no existe', async () => {
    deps.resets.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    });
    await expect(service.reset('inventado', 'nueva123')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rechaza un enlace ya usado y otro vencido', async () => {
    deps.resets.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    });
    await expect(service.reset('t', 'nueva123')).rejects.toBeInstanceOf(
      GoneException,
    );

    deps.resets.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        expiresAt: new Date(Date.now() - 1),
      }),
    });
    await expect(service.reset('t', 'nueva123')).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(deps.users.setPassword).not.toHaveBeenCalled();
  });

  it('cambia la contraseña, cierra las sesiones y consume el enlace', async () => {
    const doc = {
      ...entry,
      userId: 'u1',
      email: 'due@negocio.com',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: undefined as Date | undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
    deps.resets.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(doc),
    });
    const user = { id: 'u1' };
    deps.users.findById.mockResolvedValue(user);

    await service.reset('token-bueno', 'nueva123');

    expect(deps.users.setPassword).toHaveBeenCalledWith(user, 'nueva123');
    expect(deps.auth.revokeAllSessions).toHaveBeenCalledWith('u1');
    expect(doc.usedAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalled();
  });
});
