import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { errorDvCliente } from '../domain/datos-fiscales';

/**
 * Asignarle una lista de precios a un cliente es decidir el precio que se le
 * cobra: pide el mismo permiso que elegirla a mano en la venta (ítem 4.11).
 * Sin esto, un cajero con `customers.manage` y sin `pos.discount.authorize`
 * le ponía la lista mayorista a un cliente y la venta la aplicaba sola.
 * Quitarla (volver a precio de mostrador) no lo pide.
 */
function assertPuedeAsignarLista(
  nueva: Types.ObjectId | undefined,
  actual: Types.ObjectId | undefined,
  permisos: string[],
): void {
  if (!nueva || (actual && nueva.equals(actual))) return;
  if (!permisos.includes(PERMISSIONS.POS_DISCOUNT_AUTHORIZE)) {
    throw new ForbiddenException(
      'Asignar una lista de precios requiere permiso para autorizar descuentos',
    );
  }
}

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

/** Rechaza un NIT cuyo DV no cuadra, diciendo qué campo corregir. */
function assertDvValido(c: {
  dianDocType?: string;
  docType?: string;
  docNumber?: string;
  nitDv?: string;
}): void {
  const error = errorDvCliente(c);
  if (error) throw new BadRequestException(error);
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
    permisos: string[] = [],
  ): Promise<CustomerDocument> {
    const priceListId = parsePriceListId(dto.priceListId);
    assertPuedeAsignarLista(priceListId, undefined, permisos);
    assertDvValido({
      dianDocType: dto.dianDocType,
      docType: dto.docType ?? 'CC',
      docNumber: dto.docNumber,
      nitDv: dto.nitDv,
    });
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
        priceListId,
        dianDocType: dto.dianDocType || undefined,
        nitDv: dto.nitDv?.trim() || undefined,
        tipoPersona: dto.tipoPersona || undefined,
        responsabilidadesFiscales: dto.responsabilidadesFiscales,
        regimen: dto.regimen || undefined,
        municipioDane: dto.municipioDane?.trim() || undefined,
        emailFacturacion: dto.emailFacturacion?.trim() || undefined,
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
    permisos: string[] = [],
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
      const nueva = parsePriceListId(dto.priceListId);
      assertPuedeAsignarLista(nueva, c.priceListId ?? undefined, permisos);
      c.priceListId = nueva;
    }
    if (dto.dianDocType !== undefined) c.dianDocType = dto.dianDocType || undefined;
    if (dto.nitDv !== undefined) c.nitDv = dto.nitDv.trim() || undefined;
    if (dto.tipoPersona !== undefined) c.tipoPersona = dto.tipoPersona || undefined;
    if (dto.responsabilidadesFiscales !== undefined) {
      c.responsabilidadesFiscales = dto.responsabilidadesFiscales;
    }
    if (dto.regimen !== undefined) c.regimen = dto.regimen || undefined;
    if (dto.municipioDane !== undefined) {
      c.municipioDane = dto.municipioDane.trim() || undefined;
    }
    if (dto.emailFacturacion !== undefined) {
      c.emailFacturacion = dto.emailFacturacion.trim() || undefined;
    }
    // Solo si se tocó el tipo o el DV: un cliente viejo con el DV mal escrito no
    // debe quedar bloqueado para cambiar su teléfono.
    if (dto.dianDocType !== undefined || dto.nitDv !== undefined) assertDvValido(c);
    if (dto.notes !== undefined) c.notes = dto.notes.trim() || undefined;
    if (dto.active !== undefined) c.active = dto.active;
    await c.save();
    return c;
  }
}
