import { describe, it, expect, vi, beforeEach } from 'vitest';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Aquí los modelos van
// mockeados. Mismo patrón que `sales/application/orders.service.checkout.spec.ts`.
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

import { RolesService } from './roles.service';
import { ROLES } from '../domain/roles';
import { ALL_PERMISSIONS, PERMISSIONS } from '../domain/permissions';

/**
 * De dónde salen los permisos de un rol.
 *
 * Esto se rompió en producción y por eso hay test. Los permisos se escriben en
 * la colección `roles` al REGISTRAR la empresa, así que toda función publicada
 * después nacía invisible para los dueños que ya existían: el Dueño —que por
 * definición puede todo— no veía el módulo nuevo, y no había forma de notarlo
 * salvo que alguien lo reportara. Nadie puede editar Dueño ni Administrador
 * (`update` lo prohíbe), así que su fila guardada solo aspiraba a ser un espejo
 * del código; ahora el código es la fuente y la fila deja de poder envejecer.
 *
 * El servicio se instancia DIRECTAMENTE con modelos mockeados: (roleModel,
 * userModel).
 */
describe('RolesService · permisos vigentes de cada rol', () => {
  /** Fila guardada de un rol, con la lista de permisos que se le pase. */
  function storedRole(key: string, permissions: string[]) {
    return {
      id: `id-${key}`,
      key,
      name: key,
      description: '',
      permissions,
      isSystem: true,
    };
  }

  let roleModel: any;
  let userModel: any;
  let service: RolesService;
  let stored: Record<string, ReturnType<typeof storedRole>>;

  beforeEach(() => {
    // Una base "vieja": las filas se escribieron antes de que existiera
    // Producción, así que ningún rol la tiene guardada.
    const legacy = ALL_PERMISSIONS.filter(
      (p) =>
        p !== PERMISSIONS.PRODUCTION_VIEW && p !== PERMISSIONS.PRODUCTION_MANAGE,
    );
    stored = {
      [ROLES.OWNER]: storedRole(ROLES.OWNER, legacy),
      [ROLES.ADMIN]: storedRole(ROLES.ADMIN, legacy),
      [ROLES.MANAGER]: storedRole(ROLES.MANAGER, [PERMISSIONS.POS_SELL]),
    };

    roleModel = {
      findOne: vi.fn(({ key }: { key: string }) => ({
        exec: () => Promise.resolve(stored[key] ?? null),
      })),
      find: vi.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve(Object.values(stored)) }),
      })),
    };
    userModel = { countDocuments: vi.fn(() => ({ exec: () => Promise.resolve(0) })) };
    service = new RolesService(roleModel as never, userModel as never);
  });

  it('el Dueño tiene TODOS los permisos, incluidos los publicados después', async () => {
    const perms = await service.permissionsForRole(ROLES.OWNER);

    expect(perms).toEqual(expect.arrayContaining([...ALL_PERMISSIONS]));
    // El caso concreto que falló: la fila guardada no lo tenía.
    expect(perms).toContain(PERMISSIONS.PRODUCTION_VIEW);
    expect(stored[ROLES.OWNER]!.permissions).not.toContain(
      PERMISSIONS.PRODUCTION_VIEW,
    );
  });

  it('el Administrador también los recibe, menos ver todas las sedes', async () => {
    const perms = await service.permissionsForRole(ROLES.ADMIN);

    expect(perms).toContain(PERMISSIONS.PRODUCTION_MANAGE);
    // Puede haber un administrador por sede: no ve las demás.
    expect(perms).not.toContain(PERMISSIONS.SEDE_VIEW_ALL);
  });

  it('no regala permisos nuevos a los roles que SÍ se pueden editar', async () => {
    // Gerente es editable: si el negocio le recortó permisos, esa decisión
    // manda. Añadirle en silencio cada capacidad nueva sería abrir acceso que
    // nadie autorizó.
    const perms = await service.permissionsForRole(ROLES.MANAGER);

    expect(perms).toEqual([PERMISSIONS.POS_SELL]);
    expect(perms).not.toContain(PERMISSIONS.PRODUCTION_MANAGE);
  });

  it('un rol inexistente no da permisos', async () => {
    expect(await service.permissionsForRole('inventado')).toEqual([]);
  });

  it('no depende de que la fila del Dueño exista en la base', async () => {
    delete stored[ROLES.OWNER];

    const perms = await service.permissionsForRole(ROLES.OWNER);

    expect(perms).toContain(PERMISSIONS.PRODUCTION_VIEW);
  });

  it('la pantalla de roles muestra los permisos que de verdad se aplican', async () => {
    const views = await service.list();
    const owner = views.find((v) => v.key === ROLES.OWNER);
    const manager = views.find((v) => v.key === ROLES.MANAGER);

    // Si pintara la fila guardada, el Dueño se vería con menos de los que tiene.
    expect(owner?.permissions).toContain(PERMISSIONS.PRODUCTION_VIEW);
    // El editable se sigue mostrando tal como está guardado.
    expect(manager?.permissions).toEqual([PERMISSIONS.POS_SELL]);
  });

  /**
   * Un rol de sistema ya se puede editar, y esa es justo la razón por la que el
   * código deja de mandar en cuanto se toca: si siguiera mandando, el dueño
   * recortaría a su Administrador, se desplegaría cualquier cosa y el recorte
   * se desharía solo, sin avisar.
   */
  describe('cuando se editan a mano', () => {
    /** Prepara un rol guardado como "ya editado" con los permisos que se pasen. */
    function editado(key: string, permissions: string[]) {
      stored[key] = {
        ...storedRole(key, permissions),
        permissionsCustomized: true,
      } as never;
    }

    it('un Administrador recortado manda sobre el código', async () => {
      editado(ROLES.ADMIN, [PERMISSIONS.POS_SELL]);

      const perms = await service.permissionsForRole(ROLES.ADMIN);

      expect(perms).toEqual([PERMISSIONS.POS_SELL]);
      // Y ya no recibe solo lo que se publique después: es el precio de tocarlo.
      expect(perms).not.toContain(PERMISSIONS.PRODUCTION_MANAGE);
    });

    it('la pantalla los muestra recortados, no como los pinta el código', async () => {
      editado(ROLES.OWNER, [PERMISSIONS.POS_SELL]);

      const views = await service.list();

      expect(views.find((v) => v.key === ROLES.OWNER)?.permissions).toEqual([
        PERMISSIONS.POS_SELL,
      ]);
    });

    it('marca el rol como editado al guardar los permisos', async () => {
      const fila: any = {
        ...storedRole(ROLES.ADMIN, [...ALL_PERMISSIONS]),
        save: vi.fn(() => Promise.resolve()),
      };
      roleModel.findById = vi.fn(() => ({ exec: () => Promise.resolve(fila) }));

      await service.update('id-admin', { permissions: [PERMISSIONS.POS_SELL] });

      expect(fila.permissionsCustomized).toBe(true);
      expect(fila.permissions).toEqual([PERMISSIONS.POS_SELL]);
    });
  });

  /**
   * La única puerta que no se puede cerrar es la propia: quitarle a MI rol el
   * permiso de gestionar roles o usuarios deja la cuenta muerta, porque el
   * único que podía devolverlo era yo.
   */
  describe('candado contra dejarse fuera', () => {
    function filaEditable(key: string) {
      const fila: any = {
        ...storedRole(key, [...ALL_PERMISSIONS]),
        save: vi.fn(() => Promise.resolve()),
      };
      roleModel.findById = vi.fn(() => ({ exec: () => Promise.resolve(fila) }));
      return fila;
    }

    it('no deja quitarse a uno mismo la gestión de roles', async () => {
      filaEditable(ROLES.OWNER);
      const sinRoles = ALL_PERMISSIONS.filter(
        (p) => p !== PERMISSIONS.ROLES_MANAGE,
      );

      await expect(
        service.update('id-owner', { permissions: sinRoles }, { role: ROLES.OWNER }),
      ).rejects.toThrow(/tu propio rol/i);
    });

    it('no deja quitarse a uno mismo la gestión de usuarios', async () => {
      filaEditable(ROLES.OWNER);
      const sinUsuarios = ALL_PERMISSIONS.filter(
        (p) => p !== PERMISSIONS.USERS_MANAGE,
      );

      await expect(
        service.update('id-owner', { permissions: sinUsuarios }, { role: ROLES.OWNER }),
      ).rejects.toThrow(/tu propio rol/i);
    });

    it('sí deja recortar ESE mismo permiso en un rol ajeno', async () => {
      // Quien edita es dueño y toca Administrador: siempre quedará él para
      // deshacerlo, así que aquí no hay nada que proteger.
      const fila = filaEditable(ROLES.ADMIN);
      const sinRoles = ALL_PERMISSIONS.filter(
        (p) => p !== PERMISSIONS.ROLES_MANAGE,
      );

      await service.update(
        'id-admin',
        { permissions: sinRoles },
        { role: ROLES.OWNER },
      );

      expect(fila.permissions).not.toContain(PERMISSIONS.ROLES_MANAGE);
    });

    it('deja recortar el propio rol en lo que no sea la puerta de salida', async () => {
      const fila = filaEditable(ROLES.OWNER);
      const sinProduccion = ALL_PERMISSIONS.filter(
        (p) => p !== PERMISSIONS.PRODUCTION_MANAGE,
      );

      await service.update(
        'id-owner',
        { permissions: sinProduccion },
        { role: ROLES.OWNER },
      );

      expect(fila.permissions).not.toContain(PERMISSIONS.PRODUCTION_MANAGE);
      expect(fila.permissions).toContain(PERMISSIONS.ROLES_MANAGE);
    });
  });
});
