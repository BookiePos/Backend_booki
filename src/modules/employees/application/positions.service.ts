import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Position,
  PositionDocument,
} from '../infrastructure/schemas/position.schema';
import { CreatePositionDto } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';

const MONGO_DUPLICATE_KEY = 11000;

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === MONGO_DUPLICATE_KEY
  );
}

@Injectable()
export class PositionsService {
  constructor(
    @InjectModel(Position.name)
    private readonly model: Model<PositionDocument>,
  ) {}

  list(includeInactive = false): Promise<PositionDocument[]> {
    const filter = includeInactive ? {} : { active: true };
    return this.model.find(filter).sort({ name: 1 }).exec();
  }

  async create(dto: CreatePositionDto): Promise<PositionDocument> {
    try {
      return await this.model.create({ ...dto });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Ya existe el cargo "${dto.name}"`);
      }
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdatePositionDto,
  ): Promise<PositionDocument> {
    const position = await this.getOrFail(id);
    if (dto.name !== undefined) position.name = dto.name;
    if (dto.description !== undefined)
      position.description = dto.description || undefined;
    if (dto.active !== undefined) position.active = dto.active;
    try {
      await position.save();
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Ya existe el cargo "${position.name}"`);
      }
      throw err;
    }
    return position;
  }

  async remove(id: string): Promise<void> {
    const res = await this.getOrFail(id);
    await res.deleteOne();
  }

  async getOrFail(id: string): Promise<PositionDocument> {
    const position = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).exec()
      : null;
    if (!position) throw new NotFoundException('Cargo no encontrado');
    return position;
  }
}
