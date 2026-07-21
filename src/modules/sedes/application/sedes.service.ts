import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sede, SedeDocument } from '../infrastructure/schemas/sede.schema';
import { CreateSedeDto } from './dto/create-sede.dto';
import { UpdateSedeDto } from './dto/update-sede.dto';

/** Error de índice único de Mongo (documento duplicado). */
const MONGO_DUPLICATE_KEY = 11000;

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === MONGO_DUPLICATE_KEY
  );
}

@Injectable()
export class SedesService {
  constructor(
    @InjectModel(Sede.name) private readonly sedeModel: Model<SedeDocument>,
  ) {}

  /**
   * Lista sedes. Si `scope` es un arreglo, limita a esas sedes (aislamiento
   * por usuario); si es `null`/`undefined`, devuelve todas.
   */
  list(scope?: string[] | null): Promise<SedeDocument[]> {
    const filter = scope ? { _id: { $in: scope } } : {};
    return this.sedeModel.find(filter).sort({ code: 1 }).exec();
  }

  async create(dto: CreateSedeDto): Promise<SedeDocument> {
    try {
      return await this.sedeModel.create({ ...dto });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Ya existe una sede con el código ${dto.code}`);
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateSedeDto): Promise<SedeDocument> {
    const sede = await this.findOrFail(id);

    if (dto.code !== undefined) sede.code = dto.code;
    if (dto.name !== undefined) sede.name = dto.name;
    if (dto.address !== undefined) sede.address = dto.address || undefined;
    if (dto.active !== undefined) sede.active = dto.active;

    try {
      await sede.save();
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Ya existe una sede con el código ${sede.code}`);
      }
      throw err;
    }
    return sede;
  }

  count(): Promise<number> {
    return this.sedeModel.countDocuments().exec();
  }

  async findOrFail(id: string): Promise<SedeDocument> {
    const sede = Types.ObjectId.isValid(id)
      ? await this.sedeModel.findById(id).exec()
      : null;
    if (!sede) throw new NotFoundException('Sede no encontrada');
    return sede;
  }
}
