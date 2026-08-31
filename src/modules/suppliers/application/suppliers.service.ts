import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Supplier,
  SupplierDocument,
  SupplierDocType,
} from '../infrastructure/schemas/supplier.schema';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

/** Error de índice único de Mongo (documento duplicado). */
const MONGO_DUPLICATE_KEY = 11000;

/** Deja un documento en dígitos y sin el DV final ("900.123.456-7" -> 900123456). */
function onlyDigits(value?: string): string {
  if (!value) return '';
  return value.trim().replace(/-\s*\d\s*$/, '').replace(/\D/g, '');
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === MONGO_DUPLICATE_KEY
  );
}

@Injectable()
export class SuppliersService {
  constructor(
    @InjectModel(Supplier.name)
    private readonly supplierModel: Model<SupplierDocument>,
  ) {}

  list(includeInactive = false): Promise<SupplierDocument[]> {
    const filter = includeInactive ? {} : { active: true };
    return this.supplierModel.find(filter).sort({ name: 1 }).exec();
  }

  /**
   * Busca por documento. Lo usa el escaneo de facturas para reconocer al
   * proveedor por el NIT impreso.
   *
   * Compara solo los dígitos porque el mismo NIT se escribe de muchas formas
   * ("900.123.456-7", "900123456", "900123456-7") y una comparación literal
   * dejaría de reconocer al proveedor por un punto de diferencia.
   */
  async findByDocNumber(
    docType: SupplierDocType,
    docNumber: string,
  ): Promise<SupplierDocument | null> {
    const digits = onlyDigits(docNumber);
    if (!digits) return null;
    const candidates = await this.supplierModel.find({ docType }).exec();
    return (
      candidates.find((s) => onlyDigits(s.docNumber) === digits) ?? null
    );
  }

  async create(dto: CreateSupplierDto): Promise<SupplierDocument> {
    try {
      return await this.supplierModel.create({ ...dto });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(
          `Ya existe un proveedor con el documento ${dto.docType ?? 'NIT'} ${dto.docNumber}`,
        );
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateSupplierDto): Promise<SupplierDocument> {
    const supplier = await this.getOrFail(id);

    if (dto.name !== undefined) supplier.name = dto.name;
    if (dto.docType !== undefined) supplier.docType = dto.docType;
    if (dto.docNumber !== undefined) supplier.docNumber = dto.docNumber;
    if (dto.phone !== undefined) supplier.phone = dto.phone || undefined;
    if (dto.email !== undefined) supplier.email = dto.email || undefined;
    if (dto.contactName !== undefined)
      supplier.contactName = dto.contactName || undefined;
    if (dto.address !== undefined) supplier.address = dto.address || undefined;
    if (dto.city !== undefined) supplier.city = dto.city || undefined;
    if (dto.category !== undefined)
      supplier.category = dto.category || undefined;
    if (dto.notes !== undefined) supplier.notes = dto.notes || undefined;

    try {
      await supplier.save();
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(
          `Ya existe un proveedor con el documento ${supplier.docType} ${supplier.docNumber}`,
        );
      }
      throw err;
    }
    return supplier;
  }

  /** Activa o desactiva; no se borra para conservar el historial. */
  async setStatus(id: string, active: boolean): Promise<SupplierDocument> {
    const supplier = await this.getOrFail(id);
    supplier.active = active;
    await supplier.save();
    return supplier;
  }

  async getOrFail(id: string): Promise<SupplierDocument> {
    const supplier = Types.ObjectId.isValid(id)
      ? await this.supplierModel.findById(id).exec()
      : null;
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    return supplier;
  }
}
