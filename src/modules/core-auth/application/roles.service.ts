import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role, RoleDocument } from '../infrastructure/schemas/role.schema';
import { User, UserDocument } from '../infrastructure/schemas/user.schema';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ALL_PERMISSIONS, PERMISSIONS, Permission } from '../domain/permissions';
import { SYSTEM_ROLES, ROLES } from '../domain/roles';

/**
 * Quien crea, edita o borra un rol. Es el `JwtUser` de la request (misma forma
 * que `GestorDeUsuarios`, sin depender de infraestructura). Los flujos internos
 * (semillas, registro) no lo pasan.
 */
export interface EditorDeRoles {
  role: string;
  permissions: string[];
}

/** Vista plana de un rol para la API (incluye conteo de usuarios). */
export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  /** Sus permisos se editaron a mano, así que ya no los marca el código. */
  permissionsCustomized: boolean;
  userCount: number;
}

/**
 * Roles de sistema cuyos permisos se resuelven desde el código MIENTRAS nadie
 * los haya editado. Ya no son intocables: ver `permisosVigentes`.
 */
const CODE_DRIVEN_ROLES: string[] = [ROLES.OWNER, ROLES.ADMIN];

/**
 * Roles de sistema añadidos DESPUÉS de que existieran empresas. Los roles se
 * siembran al registrar, así que a una empresa anterior le falta la fila y el
 * Dueño no podría invitar a nadie con ese rol. Se crean al primer uso, sin
 * tocar los permisos de uno que ya exista (`$setOnInsert`).
 */
const ROLES_DE_SISTEMA_TARDIOS: string[] = [ROLES.ACCOUNTANT];

/** Definición en código de cada rol de sistema, por clave. */
const SYSTEM_ROLE_BY_KEY = new Map(
  SYSTEM_ROLES.map((def) => [def.key, def]),
);

/**
 * Los permisos que de verdad se aplican a un rol.
 *
 * Dueño y Administrador se resuelven desde el CÓDIGO mientras nadie los haya
 * tocado, y esa regla resuelve un problema concreto: los permisos se escriben
 * al REGISTRAR la empresa, así que toda función publicada después nacía
 * invisible para los dueños que ya existían. Había que correr una semilla
 * contra la base de cada empresa y, mientras tanto, el Dueño —que por
 * definición puede todo— no veía el módulo nuevo. Leyéndolos del código, una
 * capacidad nueva le llega sola a todos los dueños al desplegar.
 *
 * Antes eso se conseguía prohibiendo editarlos, y ahí estaba el problema que
 * levantó el dueño: "Administrador" o "Gerente" no significan lo mismo en una
 * galletería que en un restaurante, y un rol que no se puede ajustar convierte
 * la pantalla de roles en un adorno.
 *
 * Con `permissionsCustomized` se tienen las dos cosas. Sin tocar, manda el
 * código y las funciones nuevas llegan solas. En cuanto alguien edita el rol,
 * manda su fila y nadie se la vuelve a pisar.
 *
 * Gerente, Cajero y los roles a medida nunca leyeron del código, y sigue igual:
 * son editables desde siempre, así que su fila es la verdad, y regalarles en
 * silencio cada permiso nuevo sería abrir acceso que nadie autorizó.
 */
function permisosVigentes(role: {
  key: string;
  permissions: string[];
  permissionsCustomized?: boolean;
}): string[] {
  if (role.permissionsCustomized) return role.permissions;
  if (!CODE_DRIVEN_ROLES.includes(role.key)) return role.permissions;
  const delCodigo: Permission[] | undefined =
    SYSTEM_ROLE_BY_KEY.get(role.key)?.permissions;
  return delCodigo ? [...delCodigo] : role.permissions;
}

@Injectable()
export class RolesService {
  private readonly logger = new Logger('RolesService');

  constructor(
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  // Nota (multi-empresa): antes se sincronizaban los roles al arrancar
  // (onModuleInit), pero eso apuntaba a una única base. Ahora cada empresa tiene
  // su propia base, así que `ensureSystemRoles()` se llama al registrar la
  // empresa (RegistrationService) y en los seeders, dentro del contexto de la
  // empresa correspondiente.

  /** Lista todos los roles con el número de usuarios que los tienen. */
  async list(): Promise<RoleView[]> {
    for (const key of ROLES_DE_SISTEMA_TARDIOS) await this.asegurarRolTardio(key);
    const roles = await this.roleModel.find().sort({ isSystem: -1, name: 1 }).exec();
    const views: RoleView[] = [];
    for (const role of roles) {
      const userCount = await this.userModel
        .countDocuments({ role: role.key })
        .exec();
      views.push(this.toView(role, userCount));
    }
    return views;
  }

  async findByKey(key: string): Promise<RoleDocument | null> {
    const normalized = key.toLowerCase();
    const existente = await this.roleModel.findOne({ key: normalized }).exec();
    if (existente || !ROLES_DE_SISTEMA_TARDIOS.includes(normalized)) {
      return existente;
    }
    await this.asegurarRolTardio(normalized);
    return this.roleModel.findOne({ key: normalized }).exec();
  }

  /** Crea la fila de un rol de sistema tardío si falta; nunca pisa una existente. */
  private async asegurarRolTardio(key: string): Promise<void> {
    const def = SYSTEM_ROLE_BY_KEY.get(key);
    if (!def) return;
    const previo = await this.roleModel.findOne({ key }).exec();
    if (previo) {
      if (!previo.isSystem) {
        this.logger.warn(
          `Rol a medida «${key}» ya existe: no se crea el rol de sistema homónimo.`,
        );
      }
      return;
    }
    try {
      await this.roleModel
        .updateOne(
          { key },
          {
            $setOnInsert: {
              name: def.name,
              description: def.description,
              permissions: def.permissions,
              isSystem: true,
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (err) {
      // Dos pedidos a la vez: el segundo choca con la clave única y la fila ya está.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  /**
   * Permisos vigentes de un rol. Vacío si el rol no existe.
   *
   * Un Dueño o Administrador que NUNCA se ha editado se resuelve desde el
   * código, para que las funciones nuevas le lleguen sin migración; en cuanto
   * se edita, manda su fila. Ver `permisosVigentes`.
   */
  async permissionsForRole(key: string): Promise<string[]> {
    const normalized = key.toLowerCase();
    const role = await this.findByKey(normalized);
    if (role) return permisosVigentes(role);
    // Sin fila en la base, un Dueño o Administrador sigue resolviéndose desde
    // el código. No es un caso teórico: si la semilla de la empresa no llegó a
    // correr, la alternativa sería un dueño sin un solo permiso, incapaz de
    // entrar a arreglarlo.
    if (!CODE_DRIVEN_ROLES.includes(normalized)) return [];
    const delCodigo = SYSTEM_ROLE_BY_KEY.get(normalized)?.permissions;
    return delCodigo ? [...delCodigo] : [];
  }

  async create(dto: CreateRoleDto, editor?: EditorDeRoles): Promise<RoleView> {
    this.assertValidPermissions(dto.permissions);
    if (editor) this.assertPuedeConceder(editor, dto.permissions);
    const key = await this.uniqueSlug(dto.name);
    const created = await this.roleModel.create({
      key,
      name: dto.name.trim(),
      description: dto.description ?? '',
      permissions: dto.permissions,
      isSystem: false,
    });
    return this.toView(created, 0);
  }

  /**
   * `editor` es quien está haciendo el cambio. Con él se cierran las puertas a
   * la cuenta del Dueño (ítem 3.1) y la de dejarse fuera a uno mismo; ver
   * `assertPuedeEditarRol`.
   */
  async update(
    id: string,
    dto: UpdateRoleDto,
    editor?: EditorDeRoles,
  ): Promise<RoleView> {
    const role = await this.roleModel.findById(id).exec();
    if (!role) {
      throw new NotFoundException('Rol no encontrado');
    }
    if (editor) {
      this.assertPuedeEditarRol(role, dto, editor);
    }
    if (dto.name !== undefined) {
      role.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      role.description = dto.description;
    }
    if (dto.permissions !== undefined) {
      this.assertValidPermissions(dto.permissions);
      this.assertNoSelfLockout(role.key, dto.permissions, editor);
      this.assertDuenoConservaLaLlave(role.key, dto.permissions);
      // La pantalla reenvía el formulario entero: renombrar un Dueño o
      // Administrador manda los mismos permisos. Eso no es editarlos, y marcarlo
      // como tal congelaría el rol (dejaría de recibir funciones nuevas).
      const vigentes = new Set(permisosVigentes(role));
      const nuevos = new Set(dto.permissions);
      const cambia =
        vigentes.size !== nuevos.size || [...nuevos].some((p) => !vigentes.has(p));
      if (cambia) {
        role.permissions = dto.permissions;
        // A partir de aquí manda esta fila y no el código: es lo que evita que el
        // despliegue siguiente le deshaga el recorte en silencio.
        role.permissionsCustomized = true;
      }
    }
    await role.save();
    const userCount = await this.userModel
      .countDocuments({ role: role.key })
      .exec();
    return this.toView(role, userCount);
  }

  /**
   * Borrar no necesita reglas de rango: solo se borran roles a medida y sin
   * usuarios, así que quitarlo no le resta acceso a nadie. Quien tiene un rol
   * no puede borrarlo porque ese rol tiene, al menos, un usuario: él.
   */
  async remove(id: string): Promise<void> {
    const role = await this.roleModel.findById(id).exec();
    if (!role) {
      throw new NotFoundException('Rol no encontrado');
    }
    if (role.isSystem) {
      throw new ForbiddenException('No se puede eliminar un rol de sistema');
    }
    const userCount = await this.userModel
      .countDocuments({ role: role.key })
      .exec();
    if (userCount > 0) {
      throw new ConflictException('Hay usuarios con este rol');
    }
    await role.deleteOne();
  }

  /**
   * Upsert idempotente de los roles de sistema (usado por el seed).
   *
   * Los permisos solo se escriben si el rol NO se ha editado a mano. Sin ese
   * filtro, cualquier semilla posterior le devolvería a un Administrador
   * recortado todos los permisos que el dueño acababa de quitarle, y sin decir
   * nada. Nombre y descripción sí se refrescan siempre: son cosméticos.
   */
  async ensureSystemRoles(): Promise<void> {
    for (const def of SYSTEM_ROLES) {
      const existente = await this.roleModel.findOne({ key: def.key }).exec();

      // Rol a medida con la clave de un rol de sistema posterior: no es nuestro.
      if (existente && !existente.isSystem && ROLES_DE_SISTEMA_TARDIOS.includes(def.key)) {
        this.logger.warn(
          `Rol a medida «${def.key}» ya existe: se omite el rol de sistema homónimo.`,
        );
        continue;
      }

      // Rol editado a mano: no se toca nada suyo. Solo se reafirma que es de
      // sistema, que es lo que impide borrarlo.
      if (existente?.permissionsCustomized) {
        if (!existente.isSystem) {
          existente.isSystem = true;
          await existente.save();
        }
        continue;
      }

      // El filtro va solo por `key` —la clave única— para que el upsert
      // encuentre siempre la fila que existe. Filtrar además por
      // `permissionsCustomized` dejaría el upsert sin coincidencia sobre un rol
      // ya editado e intentaría INSERTARLO otra vez, con choque de clave.
      await this.roleModel
        .updateOne(
          { key: def.key },
          {
            $set: {
              name: def.name,
              description: def.description,
              permissions: def.permissions,
              isSystem: true,
            },
          },
          { upsert: true },
        )
        .exec();
    }
  }

  /**
   * La única puerta que no se puede cerrar: la propia.
   *
   * Los roles de sistema ya se pueden editar enteros —era lo que pedía el
   * dueño, y con razón: un "Gerente" o un "Administrador" no significan lo
   * mismo en una galletería que en un restaurante, y si el sistema decide por
   * él, sobra la pantalla de roles—. Pero hay un movimiento que no tiene vuelta
   * atrás: quitarle a MI PROPIO rol el permiso de gestionar roles o usuarios.
   *
   * En cuanto se guarda, esta pantalla deja de abrirse, y no hay nadie que
   * pueda devolver el permiso porque el único que podía era yo. La cuenta queda
   * muerta y solo se rescata metiendo mano en la base de datos.
   *
   * Por eso se bloquea ese caso sobre el rol que el editor tiene puesto. Hoy
   * solo llega aquí el Dueño editando el rol Dueño: quien no es Dueño ya no
   * edita los permisos de su propio rol (`assertPuedeEditarRol`). Se conserva
   * por el mensaje, que explica el porqué mejor que el invariante genérico.
   */
  private assertNoSelfLockout(
    roleKey: string,
    permissions: string[],
    editor?: { role: string },
  ): void {
    if (!editor || editor.role !== roleKey) return;
    const next = new Set(permissions);
    const perdidas = [
      PERMISSIONS.ROLES_MANAGE,
      PERMISSIONS.USERS_MANAGE,
    ].filter((p) => !next.has(p));
    if (perdidas.length === 0) return;
    throw new ForbiddenException(
      'No puedes quitarle a tu propio rol el permiso de gestionar roles o usuarios: ' +
        'nadie podría devolvértelo y te quedarías fuera de esta pantalla para siempre. ' +
        'Hazlo desde otra cuenta que tenga esos permisos.',
    );
  }

  /**
   * `roles.manage` no puede ser un atajo hacia arriba (ítem 3.1). Sin estas
   * reglas, un Administrador se añadía a SU PROPIO rol `sede.view_all` o lo que
   * le faltara, y podía recortar el rol Dueño hasta dejar al Dueño fuera.
   *  - Al rol Dueño solo lo toca un Dueño (nombre incluido).
   *  - Quien no es Dueño no edita los permisos del rol que tiene puesto: se lo
   *    pide a otro. Reenviar la misma lista (la pantalla manda el formulario
   *    entero) no cuenta como editarla.
   *  - Nadie añade a un rol permisos que él no tiene. El Dueño queda fuera de
   *    esta regla: es la raíz de la confianza y, si alguien recortó el rol
   *    Dueño, no hay nadie por encima que pueda devolverle lo recortado.
   */
  private assertPuedeEditarRol(
    role: RoleDocument,
    dto: UpdateRoleDto,
    editor: EditorDeRoles,
  ): void {
    const esDueno = editor.role === ROLES.OWNER;
    if (role.key === ROLES.OWNER && !esDueno) {
      throw new ForbiddenException('Solo el Dueño puede editar el rol Dueño');
    }
    if (dto.permissions === undefined || esDueno) return;
    const actuales = new Set(permisosVigentes(role));
    const nuevos = dto.permissions.filter((p) => !actuales.has(p));
    const cambian =
      nuevos.length > 0 || new Set(dto.permissions).size !== actuales.size;
    if (role.key === editor.role && cambian) {
      throw new ForbiddenException(
        'No puedes cambiar los permisos de tu propio rol: pídeselo a otra persona que gestione roles.',
      );
    }
    this.assertPuedeConceder(editor, nuevos);
  }

  private assertPuedeConceder(
    editor: EditorDeRoles,
    permissions: string[],
  ): void {
    if (editor.role === ROLES.OWNER) return;
    const propios = new Set(editor.permissions);
    const ajenos = permissions.filter((p) => !propios.has(p));
    if (ajenos.length > 0) {
      throw new ForbiddenException(
        `No puedes conceder permisos que no tienes: ${ajenos.join(', ')}`,
      );
    }
  }

  /**
   * Invariante, no permiso: el rol Dueño nunca pierde la gestión de usuarios ni
   * de roles, la edite quien la edite (o un flujo interno). Sin ellas nadie en
   * la empresa podría volver a abrir estas pantallas.
   */
  private assertDuenoConservaLaLlave(
    roleKey: string,
    permissions: string[],
  ): void {
    if (roleKey !== ROLES.OWNER) return;
    const next = new Set(permissions);
    const perdidas = [PERMISSIONS.ROLES_MANAGE, PERMISSIONS.USERS_MANAGE].filter(
      (p) => !next.has(p),
    );
    if (perdidas.length > 0) {
      throw new BadRequestException(
        `El rol Dueño no puede perder: ${perdidas.join(', ')}`,
      );
    }
  }

  private assertValidPermissions(permissions: string[]): void {
    const allowed = new Set<string>(ALL_PERMISSIONS as Permission[]);
    const invalid = permissions.filter((p) => !allowed.has(p));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Permisos no válidos: ${invalid.join(', ')}`,
      );
    }
  }

  /** Genera un slug único a partir del nombre (sin acentos ni símbolos). */
  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'rol';
    let candidate = base;
    let n = 2;
    while (await this.roleModel.exists({ key: candidate })) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    return candidate;
  }

  private toView(role: RoleDocument, userCount: number): RoleView {
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      // Se muestran como se aplican de verdad: si la pantalla pintara la fila
      // guardada, un Dueño sin editar vería menos permisos de los que realmente
      // tiene en cuanto se publique una función nueva.
      permissions: permisosVigentes(role),
      isSystem: role.isSystem,
      // Para que la pantalla pueda avisar de lo que cambia al editarlo: un rol
      // sin tocar sigue recibiendo solo las funciones nuevas; uno tocado, no.
      permissionsCustomized: role.permissionsCustomized ?? false,
      userCount,
    };
  }
}
