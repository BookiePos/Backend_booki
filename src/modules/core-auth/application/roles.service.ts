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

  /** Permisos de un rol resueltos desde la DB (vacío si no existe). */
  async permissionsForRole(key: string): Promise<string[]> {
    const role = await this.findByKey(key);
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
      permissions: role.permissions,
      isSystem: role.isSystem,
      userCount,
    };
  }
}
