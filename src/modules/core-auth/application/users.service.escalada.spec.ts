import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mismo mock que `invitations.service.tenant.spec.ts`: SWC emite `Object` como
// metadata para los @Prop() con uniones de literales y @nestjs/mongoose revienta
// al importar los esquemas.
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

import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { InvitationsService } from './invitations.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { ALL_PERMISSIONS, PERMISSIONS } from '../domain/permissions';
import { SYSTEM_ROLES } from '../domain/roles';

/**
 * Ítem 3.1 del checklist: nadie toma la cuenta del Dueño.
 *
 * Quien tenía `users.manage` (un Administrador, o un Gerente al que se lo
 * dieran) podía ponerse `role: owner`, regalarse `sede.view_all`, cambiarle la
 * contraseña al Dueño o desactivarlo, y también invitar a alguien como Dueño.
 * Estas pruebas fijan las cuatro reglas que lo cierran:
 *  - solo el Dueño asigna o edita al Dueño;
 *  - nadie concede permisos que no tiene;
 *  - nadie edita su propio rol ni sus permisos;
 *  - `extraPermissions` solo admite permisos del catálogo.
 */

const BUSINESS_ID = '64b000000000000000000001';
const OWNER_ID = '64b0000000000000000000aa';
const ADMIN_ID = '64b0000000000000000000bb';
const CASHIER_ID = '64b0000000000000000000cc';
const OWNER2_ID = '64b0000000000000000000dd';
const SEDE_A = '64b00000000000000000a001';
const SEDE_B = '64b00000000000000000b002';
const SEDE_INEXISTENTE = '64b00000000000000000f00f';

const permsDe = (key: string): string[] => [
  ...(SYSTEM_ROLES.find((r) => r.key === key)?.permissions ?? []),
];

const dueno = {
  userId: OWNER_ID,
  role: 'owner',
  permissions: [...ALL_PERMISSIONS],
  sedeIds: [] as string[],
};
/** Administrador recortado: gestiona usuarios pero no ve todas las sedes. */
const adminPerms = permsDe('admin').filter((p) => p !== PERMISSIONS.SEDE_VIEW_ALL);
const admin = {
  userId: ADMIN_ID,
  role: 'admin',
  permissions: adminPerms,
  sedeIds: [SEDE_A],
};

function usuario(id: string, role: string, extra: string[] = []) {
  return {
    id,
    role,
    name: 'X',
    active: true,
    extraPermissions: extra,
    sedeIds: [] as { toString(): string }[],
    passwordHash: 'h',
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function rolesDoble() {
  const rolePerms: Record<string, string[]> = {
    owner: [...ALL_PERMISSIONS],
    admin: adminPerms,
    manager: permsDe('manager'),
    cashier: permsDe('cashier'),
  };
  return {
    findByKey: vi.fn(async (k: string) =>
      rolePerms[k] ? { key: k, name: k } : null,
    ),
    permissionsForRole: vi.fn(async (k: string) => rolePerms[k] ?? []),
  };
}

/** Sedes que existen en la empresa: `list(ids)` devuelve solo esas. */
function sedesDoble() {
  return {
    list: vi.fn(async (ids?: string[] | null) =>
      (ids ?? [SEDE_A, SEDE_B])
        .filter((id) => id === SEDE_A || id === SEDE_B)
        .map((id) => ({ id })),
    ),
  };
}

describe('UsersService · nadie toma la cuenta del Dueño', () => {
  let usuarios: Record<string, ReturnType<typeof usuario>>;
  let refreshModel: { updateMany: ReturnType<typeof vi.fn> };
  let service: UsersService;

  beforeEach(() => {
    usuarios = {
      [OWNER_ID]: usuario(OWNER_ID, 'owner'),
      [ADMIN_ID]: usuario(ADMIN_ID, 'admin'),
      [CASHIER_ID]: usuario(CASHIER_ID, 'cashier'),
    };
    const userModel: any = {
      findById: vi.fn((id: string) => ({
        exec: () => Promise.resolve(usuarios[id] ?? null),
      })),
      create: vi.fn(async (doc: unknown) => doc),
      // Con filtro cuenta de verdad (lo usa la regla del último Dueño); sin
      // filtro es la cuota de usuarios del plan.
      countDocuments: vi.fn((filter?: { role?: string; active?: boolean }) => ({
        exec: () =>
          Promise.resolve(
            filter
              ? Object.values(usuarios).filter(
                  (u) =>
                    (filter.role === undefined || u.role === filter.role) &&
                    (filter.active === undefined || u.active === filter.active),
                ).length
              : 1,
          ),
      })),
    };
    const directory = {
      exists: vi.fn().mockResolvedValue(false),
      usernameExists: vi.fn().mockResolvedValue(false),
      link: vi.fn().mockResolvedValue(undefined),
    };
    refreshModel = {
      updateMany: vi.fn(() => ({ exec: () => Promise.resolve() })),
    };
    service = new UsersService(
      userModel as never,
      rolesDoble() as never,
      directory as never,
      sedesDoble() as never,
      refreshModel as never,
    );
  });

  const crear = (dto: Record<string, unknown>, actor: typeof admin) =>
    TenantContext.run({ businessId: BUSINESS_ID, dbName: `biz_${BUSINESS_ID}` } as never, () =>
      service.create(
        { email: 'n@x.com', password: 'Secreta1!', name: 'N', ...dto } as never,
        actor,
      ),
    );

  // ---- Solo el Dueño asigna o edita al Dueño ----

  it('un Administrador no se pone a sí mismo rol de Dueño', async () => {
    await expect(
      service.update(ADMIN_ID, { role: 'owner' }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usuarios[ADMIN_ID]!.role).toBe('admin');
  });

  it('un Administrador no le asigna rol de Dueño a otro', async () => {
    await expect(
      service.update(CASHIER_ID, { role: 'owner' }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un Administrador no crea un usuario Dueño', async () => {
    await expect(crear({ role: 'owner' }, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('un Administrador no le cambia la contraseña al Dueño', async () => {
    await expect(
      service.update(OWNER_ID, { password: 'otra123' }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usuarios[OWNER_ID]!.save).not.toHaveBeenCalled();
  });

  it('un Administrador no desactiva al Dueño', async () => {
    await expect(
      service.update(OWNER_ID, { active: false }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usuarios[OWNER_ID]!.active).toBe(true);
  });

  it('el Dueño sí puede nombrar a otro Dueño', async () => {
    const u = await service.update(CASHIER_ID, { role: 'owner' }, dueno);
    expect(u.role).toBe('owner');
  });

  // ---- Nadie concede permisos que no tiene ----

  it('un Administrador no regala `sede.view_all` si él no lo tiene', async () => {
    await expect(
      service.update(
        CASHIER_ID,
        { extraPermissions: [PERMISSIONS.SEDE_VIEW_ALL] },
        admin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usuarios[CASHIER_ID]!.extraPermissions).toEqual([]);
  });

  it('tampoco al crear un usuario', async () => {
    await expect(
      crear(
        { role: 'cashier', extraPermissions: [PERMISSIONS.SEDE_VIEW_ALL] },
        admin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('conservar un permiso extra que ya tenía el usuario no cuenta como concederlo', async () => {
    usuarios[CASHIER_ID]!.extraPermissions = [PERMISSIONS.SEDE_VIEW_ALL];
    const u = await service.update(
      CASHIER_ID,
      { name: 'Nuevo nombre', extraPermissions: [PERMISSIONS.SEDE_VIEW_ALL] },
      admin,
    );
    expect(u.name).toBe('Nuevo nombre');
  });

  it('un Administrador sí concede lo que tiene', async () => {
    const u = await service.update(
      CASHIER_ID,
      { role: 'manager', extraPermissions: [PERMISSIONS.REPORTS_VIEW] },
      admin,
    );
    expect(u.role).toBe('manager');
  });

  // ---- Nadie edita su propio rol ni sus permisos ----

  it('nadie se da permisos extra a sí mismo, ni siquiera el Dueño', async () => {
    await expect(
      service.update(
        OWNER_ID,
        { extraPermissions: [PERMISSIONS.REPORTS_VIEW] },
        dueno,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('nadie se cambia su propio rol', async () => {
    await expect(
      service.update(ADMIN_ID, { role: 'manager' }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('editarse el nombre reenviando el mismo rol y permisos sí se puede', async () => {
    // La pantalla de usuarios manda el formulario entero en cada PATCH.
    const u = await service.update(
      ADMIN_ID,
      { name: 'Ana', role: 'admin', extraPermissions: [] },
      admin,
    );
    expect(u.name).toBe('Ana');
  });

  // ---- Contraseña y desactivación: solo sobre quien tiene menos que uno ----

  it('un Administrador no le cambia la contraseña a quien tiene permisos que él no tiene', async () => {
    usuarios[CASHIER_ID]!.extraPermissions = [PERMISSIONS.SEDE_VIEW_ALL];
    await expect(
      service.update(CASHIER_ID, { password: 'otra123' }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usuarios[CASHIER_ID]!.passwordHash).toBe('h');
  });

  it('ni lo desactiva', async () => {
    usuarios[CASHIER_ID]!.extraPermissions = [PERMISSIONS.SEDE_VIEW_ALL];
    await expect(
      service.update(CASHIER_ID, { active: false }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usuarios[CASHIER_ID]!.active).toBe(true);
  });

  it('sí le cambia la contraseña y desactiva a un Cajero', async () => {
    const u = await service.update(
      CASHIER_ID,
      { password: 'otra123', active: false },
      admin,
    );
    expect(u.active).toBe(false);
    expect(u.passwordHash).not.toBe('h');
  });

  // ---- Sedes: nadie reparte sedes que no tiene ----

  it('un Administrador limitado no asigna una sede que no es suya', async () => {
    await expect(
      service.update(CASHIER_ID, { sedeIds: [SEDE_B] }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usuarios[CASHIER_ID]!.sedeIds).toEqual([]);
  });

  it('tampoco reparte sedes ajenas al crear un usuario', async () => {
    await expect(
      crear({ role: 'cashier', sedeIds: [SEDE_B] }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sí asigna sus propias sedes', async () => {
    const u = await service.update(CASHIER_ID, { sedeIds: [SEDE_A] }, admin);
    expect(u.sedeIds.map(String)).toEqual([SEDE_A]);
  });

  it('nadie se amplía sus propias sedes', async () => {
    await expect(
      service.update(ADMIN_ID, { sedeIds: [SEDE_A, SEDE_B] }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechaza una sede que no existe en la empresa', async () => {
    await expect(
      service.update(CASHIER_ID, { sedeIds: [SEDE_INEXISTENTE] }, dueno),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      crear({ role: 'cashier', sedeIds: [SEDE_INEXISTENTE] }, dueno),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ---- La empresa nunca se queda sin Dueño activo ----

  it('el único Dueño activo no se desactiva', async () => {
    await expect(
      service.update(OWNER_ID, { active: false }, dueno),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(usuarios[OWNER_ID]!.active).toBe(true);
  });

  it('no se degrada al último Dueño activo', async () => {
    const otro = usuario(OWNER2_ID, 'owner');
    otro.active = false;
    usuarios[OWNER2_ID] = otro;
    const dueno2 = { ...dueno, userId: OWNER2_ID };
    await expect(
      service.update(OWNER_ID, { role: 'admin' }, dueno2),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(usuarios[OWNER_ID]!.role).toBe('owner');
  });

  it('con otro Dueño activo, sí se puede degradar a uno', async () => {
    usuarios[OWNER2_ID] = usuario(OWNER2_ID, 'owner');
    const dueno2 = { ...dueno, userId: OWNER2_ID };
    const u = await service.update(OWNER_ID, { role: 'admin' }, dueno2);
    expect(u.role).toBe('admin');
  });

  // ---- Ítem 3.2: lo que viaja en el JWT cambia → se cierran sus sesiones ----

  it.each([
    ['desactivarlo', { active: false }],
    ['cambiarle la contraseña', { password: 'otra123' }],
    ['cambiarle el rol', { role: 'manager' }],
    ['cambiarle los permisos extra', { extraPermissions: [PERMISSIONS.REPORTS_VIEW] }],
    ['cambiarle las sedes', { sedeIds: [SEDE_A] }],
  ])('%s le revoca las sesiones', async (_, dto) => {
    await service.update(CASHIER_ID, dto as never, admin);
    expect(refreshModel.updateMany).toHaveBeenCalledTimes(1);
    const [filtro] = refreshModel.updateMany.mock.calls[0]!;
    expect(String(filtro.userId)).toBe(CASHIER_ID);
  });

  it('cambiarse el nombre (con el formulario entero) no cierra la sesión', async () => {
    await service.update(
      ADMIN_ID,
      { name: 'Ana', role: 'admin', extraPermissions: [], sedeIds: [], active: true },
      admin,
    );
    expect(refreshModel.updateMany).not.toHaveBeenCalled();
  });

  // ---- extraPermissions contra el catálogo ----

  it('rechaza permisos inventados al editar', async () => {
    await expect(
      service.update(CASHIER_ID, { extraPermissions: ['todo.todo'] }, dueno),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza permisos inventados al crear', async () => {
    await expect(
      crear({ role: 'cashier', extraPermissions: ['todo.todo'] }, dueno),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ---- Remates 3.1/3.2 ----

  it('M1: dos Dueños que se desactivan a la vez no dejan la empresa sin Dueño', async () => {
    const b = usuario(OWNER2_ID, 'owner');
    usuarios[OWNER2_ID] = b;
    const a = usuarios[OWNER_ID]!;
    // Cuando A guarda, la otra petición (B desactivándose) ya se confirmó.
    a.save.mockImplementationOnce(async () => {
      b.active = false;
    });
    await expect(
      service.update(OWNER_ID, { active: false }, dueno),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(a.active).toBe(true);
    expect(a.save).toHaveBeenCalledTimes(2);
  });

  it('L1: no se baja de rango a quien tiene permisos que el actor no tiene', async () => {
    usuarios[CASHIER_ID]!.extraPermissions = [PERMISSIONS.SEDE_VIEW_ALL];
    await expect(
      service.update(CASHIER_ID, { role: 'manager' }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.update(CASHIER_ID, { extraPermissions: [] }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.update(CASHIER_ID, { sedeIds: [SEDE_A] }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usuarios[CASHIER_ID]!.role).toBe('cashier');
  });

  it('L1: reenviar el mismo formulario sobre alguien con más permisos no se bloquea', async () => {
    usuarios[CASHIER_ID]!.extraPermissions = [PERMISSIONS.SEDE_VIEW_ALL];
    const u = await service.update(
      CASHIER_ID,
      { name: 'Z', extraPermissions: [PERMISSIONS.SEDE_VIEW_ALL] },
      admin,
    );
    expect(u.name).toBe('Z');
  });

  it('L2: al cambiarse la contraseña uno conserva la sesión actual y cierra las demás', async () => {
    await service.update(
      ADMIN_ID,
      { password: 'otra123' },
      { ...admin, sid: 'jti-actual' },
    );
    const filtro = refreshModel.updateMany.mock.calls[0]![0];
    expect(filtro.jti).toEqual({ $ne: 'jti-actual' });
  });

  it('L2: si otro cambia la contraseña, se cierran todas', async () => {
    await service.update(
      CASHIER_ID,
      { password: 'otra123' },
      { ...admin, sid: 'jti-actual' },
    );
    expect(refreshModel.updateMany.mock.calls[0]![0].jti).toBeUndefined();
  });
});

describe('InvitationsService · invitar como Dueño', () => {
  let invitationModel: any;
  let pendientes: any[];
  let service: InvitationsService;

  /** Invitación pendiente de rol Dueño, hecha por el Dueño. */
  function invitacionDeDueno() {
    return {
      id: 'inv-owner',
      email: 'socio@y.com',
      role: 'owner',
      status: 'pending',
      tokenHash: 'viejo',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  const enEmpresa = <T>(fn: () => Promise<T>) =>
    TenantContext.run(
      { businessId: BUSINESS_ID, dbName: `biz_${BUSINESS_ID}` } as never,
      fn,
    );

  beforeEach(() => {
    pendientes = [];
    invitationModel = {
      find: vi.fn(() => ({ exec: () => Promise.resolve(pendientes) })),
      findById: vi.fn((id: string) => ({
        exec: () => Promise.resolve(pendientes.find((p) => p.id === id) ?? null),
      })),
      updateMany: vi.fn(() => ({ exec: () => Promise.resolve() })),
      create: vi.fn(async (doc: any) => ({
        ...doc,
        id: 'inv1',
        createdAt: new Date(),
      })),
    };
    const roles = rolesDoble();
    const users = new UsersService(
      { findOne: vi.fn(() => ({ exec: () => Promise.resolve(null) })) } as never,
      roles as never,
      {} as never,
      {} as never,
      {} as never,
    );
    service = new InvitationsService(
      invitationModel as never,
      { findById: vi.fn(() => ({ select: () => ({ exec: () => Promise.resolve(null) }) })) } as never,
      users as never,
      roles as never,
      { sendInvitation: vi.fn().mockResolvedValue({ sent: true }) } as never,
      {} as never,
      { get: () => undefined } as never,
    );
  });

  it('un Administrador no invita a nadie con rol de Dueño', async () => {
    await expect(
      service.create({ email: 'x@y.com', role: 'owner' }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(invitationModel.create).not.toHaveBeenCalled();
  });

  it('el Dueño sí puede invitar a otro Dueño', async () => {
    const inv = await TenantContext.run(
      { businessId: BUSINESS_ID, dbName: `biz_${BUSINESS_ID}` } as never,
      () => service.create({ email: 'x@y.com', role: 'owner' }, dueno),
    );
    expect(inv.role).toBe('owner');
  });

  it('nadie invita con un rol que trae permisos que él no tiene', async () => {
    const gerenteSinCaja = {
      userId: CASHIER_ID,
      role: 'recortado',
      permissions: [PERMISSIONS.USERS_MANAGE],
      sedeIds: [],
    };
    await expect(
      service.create({ email: 'x@y.com', role: 'cashier' }, gerenteSinCaja),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('un Administrador no reenvía una invitación de Dueño (y no recibe su enlace)', async () => {
    const inv = invitacionDeDueno();
    pendientes.push(inv);
    await expect(
      enEmpresa(() => service.resend('inv-owner', admin)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(inv.save).not.toHaveBeenCalled();
    expect(inv.tokenHash).toBe('viejo');
  });

  it('el Dueño sí la reenvía', async () => {
    pendientes.push(invitacionDeDueno());
    const r = await enEmpresa(() => service.resend('inv-owner', dueno));
    expect(r.inviteUrl).toContain(BUSINESS_ID);
  });

  it('un Administrador no revoca una invitación de Dueño', async () => {
    const inv = invitacionDeDueno();
    pendientes.push(inv);
    await expect(service.revoke('inv-owner', admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inv.status).toBe('pending');
  });

  it('re-invitar el mismo correo no revoca en silencio una invitación de rol superior', async () => {
    pendientes.push(invitacionDeDueno());
    await expect(
      enEmpresa(() =>
        service.create({ email: 'socio@y.com', role: 'cashier' }, admin),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(invitationModel.updateMany).not.toHaveBeenCalled();
    expect(invitationModel.create).not.toHaveBeenCalled();
  });
});
