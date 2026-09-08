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
import { ALL_PERMISSIONS, Permission } from '../domain/permissions';
import { SYSTEM_ROLES, ROLES } from '../domain/roles';

/** Vista plana de un rol para la API (incluye conteo de usuarios). */
export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  userCount: number;
}

/** Roles de sistema cuyos permisos no se pueden alterar. */
const LOCKED_PERMISSION_ROLES: string[] = [ROLES.OWNER, ROLES.ADMIN];

/** Definición en código de cada rol de sistema, por clave. */
const SYSTEM_ROLE_BY_KEY = new Map(
  SYSTEM_ROLES.map((def) => [def.key, def]),
);

/**
 * Permisos vigentes de un rol de sistema BLOQUEADO, leídos del código.
 *
 * Para Dueño y Administrador el código es la fuente de la verdad, no la fila de
 * `roles`. Nadie puede editarlos (lo impide `update`), así que esa fila solo
 * aspira a ser un espejo… y era un espejo que se quedaba viejo: los permisos se
 * escriben al REGISTRAR la empresa, de modo que toda función publicada después
 * nacía invisible para los dueños que ya existían. Había que correr una semilla
 * contra la base de cada empresa, y mientras tanto el Dueño —que por definición
 * puede todo— no veía el módulo nuevo.
 *
 * Resolviéndolo desde el código, una capacidad nueva llega sola a todos los
 * dueños en cuanto se despliega: sin migración, sin semilla y sin tocar datos.
 *
 * Devuelve `null` si el rol no es uno de los bloqueados. Gerente y Cajero NO
 * entran aquí a propósito: SÍ se pueden editar, así que su fila es la verdad, y
 * regalarles en silencio cada permiso nuevo sería abrirles acceso que nadie
 * autorizó.
 */
function lockedRolePermissions(key: string): Permission[] | null {
  if (!LOCKED_PERMISSION_ROLES.includes(key)) return null;
  return SYSTEM_ROLE_BY_KEY.get(key)?.permissions ?? null;
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

  findByKey(key: string): Promise<RoleDocument | null> {
    return this.roleModel.findOne({ key: key.toLowerCase() }).exec();
  }

  /**
   * Permisos vigentes de un rol.
   *
   * Dueño y Administrador se resuelven desde el código (ver
   * `lockedRolePermissions`); el resto, desde su fila en la base. Vacío si el
   * rol no existe.
   */
  async permissionsForRole(key: string): Promise<string[]> {
    const normalized = key.toLowerCase();
    const locked = lockedRolePermissions(normalized);
    if (locked) return [...locked];
    const role = await this.findByKey(normalized);
    return role ? role.permissions : [];
  }

  async create(dto: CreateRoleDto): Promise<RoleView> {
    this.assertValidPermissions(dto.permissions);
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

  async update(id: string, dto: UpdateRoleDto): Promise<RoleView> {
    const role = await this.roleModel.findById(id).exec();
    if (!role) {
      throw new NotFoundException('Rol no encontrado');
    }
    if (dto.name !== undefined) {
      role.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      role.description = dto.description;
    }
    if (dto.permissions !== undefined) {
      if (LOCKED_PERMISSION_ROLES.includes(role.key)) {
        throw new ForbiddenException(
          'No se pueden modificar los permisos de un rol de sistema base',
        );
      }
      this.assertValidPermissions(dto.permissions);
      role.permissions = dto.permissions;
    }
    await role.save();
    const userCount = await this.userModel
      .countDocuments({ role: role.key })
      .exec();
    return this.toView(role, userCount);
  }

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

  /** Upsert idempotente de los roles de sistema (usado por el seed). */
  async ensureSystemRoles(): Promise<void> {
    for (const def of SYSTEM_ROLES) {
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
      // Los bloqueados se muestran como se aplican de verdad: si la pantalla
      // pintara la fila guardada, un Dueño vería menos permisos de los que
      // realmente tiene en cuanto se publique una función nueva.
      permissions: lockedRolePermissions(role.key) ?? role.permissions,
      isSystem: role.isSystem,
      userCount,
    };
  }
}
