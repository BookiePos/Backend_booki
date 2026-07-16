import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from '../infrastructure/schemas/user.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { permissionsForRole } from '../domain/roles';
import { Permission } from '../domain/permissions';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async create(dto: CreateUserDto): Promise<UserDocument> {
    const email = dto.email.toLowerCase();
    const existing = await this.userModel.findOne({ email }).exec();
    if (existing) {
      throw new ConflictException('El email ya está registrado');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    return this.userModel.create({
      email,
      passwordHash,
      name: dto.name,
      role: dto.role,
      extraPermissions: dto.extraPermissions ?? [],
      sedeIds: (dto.sedeIds ?? []).map((id) => new Types.ObjectId(id)),
    });
  }

  findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
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

  /** Permisos efectivos = permisos del rol + permisos extra del usuario. */
  effectivePermissions(user: UserDocument): Permission[] {
    const set = new Set<Permission>([
      ...permissionsForRole(user.role),
      ...(user.extraPermissions as Permission[]),
    ]);
    return [...set];
  }
}
