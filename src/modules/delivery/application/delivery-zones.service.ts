import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DeliveryZone,
  DeliveryZoneDocument,
} from '../infrastructure/schemas/delivery-zone.schema';
import {
  CreateDeliveryZoneDto,
  UpdateDeliveryZoneDto,
} from './dto/delivery-zone.dto';
import { ZoneRef } from '../domain/delivery.constants';

/**
 * Zonas de domicilio con tarifa fija, por sede.
 *
 * Es a propósito lo más simple que puede ser: un nombre y un precio. La
 * decisión de no calcular por kilómetros está explicada en
 * `domain/delivery.constants.ts` y no conviene revolverla.
 */
@Injectable()
export class DeliveryZonesService {
  constructor(
    @InjectModel(DeliveryZone.name)
    private readonly model: Model<DeliveryZoneDocument>,
  ) {}

  list(sedeId: string, includeInactive = false): Promise<DeliveryZoneDocument[]> {
    const filtro: Record<string, unknown> = {
      sedeId: new Types.ObjectId(sedeId),
    };
    if (!includeInactive) filtro.active = true;
    return this.model.find(filtro).sort({ fee: 1, name: 1 }).exec();
  }

  async getOrFail(id: string): Promise<DeliveryZoneDocument> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).exec()
      : null;
    if (!doc) throw new NotFoundException('Zona de domicilio no encontrada');
    return doc;
  }

  create(dto: CreateDeliveryZoneDto): Promise<DeliveryZoneDocument> {
    return this.model.create({
      sedeId: new Types.ObjectId(dto.sedeId),
      name: dto.name.trim(),
      fee: Math.round(dto.fee),
      active: dto.active ?? true,
    });
  }

  async update(
    id: string,
    dto: UpdateDeliveryZoneDto,
  ): Promise<DeliveryZoneDocument> {
    const doc = await this.getOrFail(id);
    if (dto.name !== undefined) doc.name = dto.name.trim();
    if (dto.fee !== undefined) doc.fee = Math.round(dto.fee);
    if (dto.active !== undefined) doc.active = dto.active;
    await doc.save();
    return doc;
  }

  async deactivate(id: string): Promise<{ ok: boolean }> {
    const doc = await this.getOrFail(id);
    doc.active = false;
    await doc.save();
    return { ok: true };
  }

  /**
   * Carga la zona que se va a cobrar en una venta.
   *
   * Devuelve `null` si no existe, está desactivada, o es de OTRA sede. Lo
   * último importa: cada sede tiene sus tarifas, y cobrar la de Laureles desde
   * la sede del sur sería cobrar de menos sin que nadie lo note.
   */
  async refFor(
    zoneId: string | undefined,
    sedeId: string,
  ): Promise<ZoneRef | null> {
    if (!zoneId || !Types.ObjectId.isValid(zoneId)) return null;
    const doc = await this.model.findById(zoneId).exec();
    if (!doc || !doc.active) return null;
    if (doc.sedeId.toString() !== sedeId) return null;
    return { id: doc._id.toString(), name: doc.name, fee: doc.fee };
  }
}
