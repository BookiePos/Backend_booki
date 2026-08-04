import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from '../infrastructure/schemas/user.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RolesService } from './roles.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { DirectoryService } from '../../control/application/directory.service';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly roles: RolesService,
    private readonly directory: DirectoryService,
  ) {}

  async create(dto: CreateUserDto): Promise<UserDocument> {
    const { businessId, dbName } = TenantContext.currentOrThrow();
    const username = dto.username?.toLowerCase().trim() || undefined;

    if (!dto.email && !username) {
      throw new BadRequestException('Indica un email o un nombre de usuario');
    }

    // Con username y sin email, se sintetiza un email interno único por empresa
    // (`<username>@<businessId>.local`) para reusar el enrutamiento por email.
    const email = (
      dto.email ?? `${username}@${businessId}.local`
    ).toLowerCase();

    // Unicidad global de correos: no puede existir en ninguna otra empresa.
    if (await this.directory.exists(email)) {
      throw new ConflictException('El email ya está registrado');
    }
    // Unicidad global de username (enrutamiento de login por username).
    if (username && (await this.directory.usernameExists(username))) {
      throw new ConflictException('El nombre de usuario ya está en uso');
    }
    const role = await this.roles.findByKey(dto.role);
    if (!role) {
      throw new BadRequestException('Rol no válido');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const created = await this.userModel.create({
      email,
      username,
      passwordHash,
      name: dto.name,
      role: role.key,
      extraPermissions: dto.extraPermissions ?? [],
      sedeIds: (dto.sedeIds ?? []).map((id) => new Types.ObjectId(id)),
    });
    // Registra el vínculo email/username → empresa para enrutar el login.
    await this.directory.link(email, businessId, dbName, username);
    return created;
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (dto.name !== undefined) {
      user.name = dto.name;
    }
    if (dto.role !== undefined) {
      const role = await this.roles.findByKey(dto.role);
      if (!role) {
        throw new BadRequestException('Rol no válido');
      }
      user.role = role.key;
    }
    if (dto.active !== undefined) {
      user.active = dto.active;
    }
    if (dto.extraPermissions !== undefined) {
      user.extraPermissions = dto.extraPermissions;
    }
    if (dto.sedeIds !== undefined) {
      user.sedeIds = dto.sedeIds.map((sid) => new Types.ObjectId(sid));
    }
    if (dto.password !== undefined) {
      user.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    }
    await user.save();
    return user;
  }

  findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  findByUsername(username: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ username: username.toLowerCase() })
      .exec();
  }

  async findById(id: string): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return user;
  }

  list(): Promise<UserDocument[]> {
    return this.userModel.find().select('-passwordHash').exec();
  }

  count(): Promise<number> {
    return this.userModel.countDocuments().exec();
  }

  verifyPassword(user: UserDocument, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }

  /** Permisos efectivos = permisos del rol (DB) + permisos extra del usuario. */
  async effectivePermissions(user: UserDocument): Promise<string[]> {
    const rolePerms = await this.roles.permissionsForRole(user.role);
    const set = new Set<string>([...rolePerms, ...user.extraPermissions]);
    return [...set];
  }
}
