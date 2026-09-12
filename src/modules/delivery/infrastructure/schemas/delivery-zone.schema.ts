import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DeliveryZoneDocument = HydratedDocument<DeliveryZone>;

/**
 * Zona de domicilio con tarifa fija: "Laureles $5.000", "Belén $7.000".
 *
 * Va por SEDE porque la tarifa depende de desde dónde sale el domicilio: la
 * misma dirección cuesta distinto según la sede que la despache.
 *
 * No hay cálculo por kilómetros a propósito — ver `domain/delivery.constants`.
 */
@Schema({ timestamps: true, collection: 'delivery_zones' })
export class DeliveryZone {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  /** Lo que se le cobra al cliente por llevarle el pedido (COP entero). */
  @Prop({ required: true, min: 0, default: 0 })
  fee!: number;

  /**
   * Se desactiva en vez de borrarse: las ventas viejas guardan el nombre y la
   * tarifa que se cobró, pero borrar la zona dejaría la lista sin historia y
   * sin forma de volver a activarla en temporada.
   */
  @Prop({ default: true })
  active!: boolean;
}

export const DeliveryZoneSchema = SchemaFactory.createForClass(DeliveryZone);

DeliveryZoneSchema.index({ sedeId: 1, name: 1 });
