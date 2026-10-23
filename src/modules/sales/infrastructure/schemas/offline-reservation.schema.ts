import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type OfflineReservationDocument = HydratedDocument<OfflineReservation>;

/**
 * Bloque de consecutivos de contingencia (`FVC-`) entregado por adelantado a
 * un terminal para vender sin internet (ítem 6.3).
 *
 * El rango sale de un `$inc` atómico sobre el contador de la sede, así que dos
 * bloques nunca se pisan. El bloque queda atado al turno de caja abierto y a
 * quien lo pidió: las ventas que se sincronicen con esos números entran a ESE
 * arqueo. Los números que no se alcancen a usar son los únicos huecos posibles
 * de la serie, y este documento los explica.
 */
@Schema({ timestamps: true, collection: 'offline_reservations' })
export class OfflineReservation {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  cajaSessionId!: Types.ObjectId;

  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true })
  userEmail!: string;

  /** Identificador del terminal (lo genera el navegador; solo trazabilidad). */
  @Prop({ required: true, trim: true })
  deviceId!: string;

  @Prop({ required: true, trim: true })
  prefix!: string;

  @Prop({ required: true, min: 1 })
  from!: number;

  @Prop({ required: true, min: 1 })
  to!: number;

  createdAt?: Date;
}

export const OfflineReservationSchema =
  SchemaFactory.createForClass(OfflineReservation);
