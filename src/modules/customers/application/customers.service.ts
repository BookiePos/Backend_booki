import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Customer,
  CustomerDocument,
} from '../infrastructure/schemas/customer.schema';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto';

/**
 * Traduce la lista de precios que llega del formulario.
 *
 * Cadena vacía (o ausente) = sin lista, se le cobra de mostrador. Cualquier
 * otra cosa tiene que ser un id de verdad: dejar pasar basura reventaría más
 * tarde como un 500 de Mongoose, lejos del formulario que la mandó.
 */
function parsePriceListId(raw?: string): Types.ObjectId | undefined {
  if (!raw) return undefined;
  if (!Types.ObjectId.isValid(raw)) {
    throw new BadRequestException('Lista de precios inválida');
  }
  return new Types.ObjectId(raw);
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}

@Injectable()
export class CustomersService {
  constructor(
    @InjectModel(Customer.name)
    private readonly customers: Model<CustomerDocument>,
  ) {}

  async list(query: {
    search?: string;
    includeInactive?: boolean;
  }): Promise<CustomerDocument[]> {
    const filter: Record<string, unknown> = {};
    if (!query.includeInactive) filter.active = true;
    if (query.search) {
      // Escapa los metacaracteres del input del usuario antes de construir la
      // regex: evita ReDoS (un patrón malicioso bloquearía el event loop).
      const escaped = query.search
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(escaped, 'i');
      filter.$or = [{ name: rx }, { docNumber: rx }, { phone: rx }];
    }
    return this.customers.find(filter).sort({ name: 1 }).limit(200).exec();
  }

  async getOrFail(id: string): Promise<CustomerDocument> {
    const c = await this.customers.findById(id).exec();
    if (!c) throw new NotFoundException('Cliente no encontrado');
    return c;
  }

  async create(
    dto: CreateCustomerDto,
    userEmail?: string,
  ): Promise<CustomerDocument> {
    try {
      return await this.customers.create({
        name: dto.name.trim(),
        docType: dto.docType ?? 'CC',
        docNumber: dto.docNumber.trim(),
        phone: dto.phone?.trim(),
        email: dto.email?.trim(),
        address: dto.address?.trim(),
        city: dto.city?.trim(),
        creditLimit: dto.creditLimit ?? 0,
        priceListId: parsePriceListId(dto.priceListId),
        notes: dto.notes?.trim(),
        active: true,
        createdByEmail: userEmail,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(
          `Ya existe un cliente con el documento ${dto.docType ?? 'CC'} ${dto.docNumber}`,
        );
      }
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerDocument> {
    const c = await this.getOrFail(id);
    if (dto.name !== undefined) c.name = dto.name.trim();
    if (dto.phone !== undefined) c.phone = dto.phone.trim() || undefined;
    if (dto.email !== undefined) c.email = dto.email.trim() || undefined;
    if (dto.address !== undefined) c.address = dto.address.trim() || undefined;
    if (dto.city !== undefined) c.city = dto.city.trim() || undefined;
    if (dto.creditLimit !== undefined) c.creditLimit = dto.creditLimit;
    // Cadena vacía = quitarle la lista y volver a cobrarle de mostrador.
    if (dto.priceListId !== undefined) {
      c.priceListId = parsePriceListId(dto.priceListId);
    }
    if (dto.notes !== undefined) c.notes = dto.notes.trim() || undefined;
    if (dto.active !== undefined) c.active = dto.active;
    await c.save();
    return c;
  }
}
