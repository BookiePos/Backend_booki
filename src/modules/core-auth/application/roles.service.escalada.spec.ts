import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mismo mock que `roles.service.system-roles.spec.ts`: SWC emite `Object` como
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
import { RolesService } from './roles.service';
import { ROLES, SYSTEM_ROLES } from '../domain/roles';
import { ALL_PERMISSIONS, PERMISSIONS } from '../domain/permissions';

/**
 * Ítem 3.1 visto desde la pantalla de roles.
 *
 * `roles.manage` era otra puerta a la cuenta del Dueño: un Administrador podía
 * añadirle a SU PROPIO rol `sede.view_all` (o cualquier permiso que no tenía),
 * y también recortar el rol Dueño hasta dejar al Dueño fuera. Reglas:
 *  - nadie concede a un rol permisos que no tiene;
 *  - nadie que no sea Dueño edita los permisos de su propio rol;
 *  - al rol Dueño solo lo toca un Dueño, y nunca pierde la gestión de
 *    usuarios ni de roles.
 */

const adminPerms = [
  ...(SYSTEM_ROLES.find((r) => r.key === ROLES.ADMIN)?.permissions ?? []),
];
const admin = {
  userId: 'a1',
  role: ROLES.ADMIN,
  permissions: adminPerms,
  sedeIds: [] as string[],
};
const dueno = {
  userId: 'o1',
  role: ROLES.OWNER,
  permissions: [...ALL_PERMISSIONS],
  sedeIds: [] as string[],
};

describe('RolesService · nadie se sube de rango desde la pantalla de roles', () => {
  let filas: Record<string, any>;
  let roleModel: any;
  let service: RolesService;

  function fila(key: string, permissions: string[]) {
    return {
      id: `id-${key}`,
      key,
      name: key,
      description: '',
      permissions: [...permissions],
      isSystem: key !== 'a-medida',
      permissionsCustomized: false,
      save: vi.fn(() => Promise.resolve()),
      deleteOne: vi.fn(() => Promise.resolve()),
    };
  }

  beforeEach(() => {
    filas = {
      'id-owner': fila(ROLES.OWNER, [...ALL_PERMISSIONS]),
      'id-admin': fila(ROLES.ADMIN, adminPerms),
      'id-manager': fila(ROLES.MANAGER, [PERMISSIONS.POS_SELL]),
    };
    roleModel = {
      findById: vi.fn((id: string) => ({
        exec: () => Promise.resolve(filas[id] ?? null),
      })),
      exists: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(async (doc: any) => ({ ...doc, id: 'nuevo' })),
    };
    const userModel = {
      countDocuments: vi.fn(() => ({ exec: () => Promise.resolve(0) })),
    };
    service = new RolesService(roleModel as never, userModel as never);
  });

  // ---- Nadie concede a un rol lo que no tiene ----

  it('un Administrador no le añade a otro rol un permiso que él no tiene', async () => {
    await expect(
      service.update(
        'id-manager',
        { permissions: [PERMISSIONS.POS_SELL, PERMISSIONS.SEDE_VIEW_ALL] },
        admin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(filas['id-manager'].save).not.toHaveBeenCalled();
  });

  it('sí añade los que tiene', async () => {
    await service.update(
      'id-manager',
      { permissions: [PERMISSIONS.POS_SELL, PERMISSIONS.REPORTS_VIEW] },
      admin,
    );
    expect(filas['id-manager'].permissions).toContain(PERMISSIONS.REPORTS_VIEW);
  });

  it('un Administrador no crea un rol con permisos que él no tiene', async () => {
    await expect(
      service.create(
        { name: 'Supervisor', permissions: [PERMISSIONS.SEDE_VIEW_ALL] },
        admin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(roleModel.create).not.toHaveBeenCalled();
  });

  // ---- Nadie edita los permisos de su propio rol (salvo el Dueño) ----

  it('un Administrador no se añade permisos a su propio rol', async () => {
    await expect(
      service.update(
        'id-admin',
        { permissions: [...adminPerms, PERMISSIONS.SEDE_VIEW_ALL] },
        admin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(filas['id-admin'].permissions).not.toContain(
      PERMISSIONS.SEDE_VIEW_ALL,
    );
  });

  it('ni siquiera reordenando o quitando: el rol propio lo edita otro', async () => {
    await expect(
      service.update(
        'id-admin',
        {
          permissions: adminPerms.filter(
            (p) => p !== PERMISSIONS.PRODUCTION_MANAGE,
          ),
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reenviar los mismos permisos del rol propio (cambiando solo el nombre) sí se puede', async () => {
    await service.update(
      'id-admin',
      { name: 'Admin de sede', permissions: [...adminPerms].reverse() },
      admin,
    );
    expect(filas['id-admin'].name).toBe('Admin de sede');
  });

  // ---- El rol Dueño ----

  it('un Administrador no recorta el rol Dueño', async () => {
    await expect(
      service.update(
        'id-owner',
        { permissions: [PERMISSIONS.POS_SELL] },
        admin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(filas['id-owner'].permissions).toEqual([...ALL_PERMISSIONS]);
  });

  it('ni le cambia el nombre', async () => {
    await expect(
      service.update('id-owner', { name: 'Socio' }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el rol Dueño nunca pierde la gestión de usuarios ni de roles', async () => {
    // Sin editor (flujos internos) también: es un invariante, no un permiso.
    await expect(
      service.update('id-owner', {
        permissions: ALL_PERMISSIONS.filter(
          (p) => p !== PERMISSIONS.USERS_MANAGE,
        ),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el Dueño puede devolverle al rol Dueño un permiso que se le recortó', async () => {
    filas['id-owner'].permissions = ALL_PERMISSIONS.filter(
      (p) => p !== PERMISSIONS.PRODUCTION_MANAGE,
    );
    filas['id-owner'].permissionsCustomized = true;
    const recortado = {
      ...dueno,
      permissions: filas['id-owner'].permissions,
    };
    await service.update(
      'id-owner',
      { permissions: [...ALL_PERMISSIONS] },
      recortado,
    );
    expect(filas['id-owner'].permissions).toContain(
      PERMISSIONS.PRODUCTION_MANAGE,
    );
  });
});
