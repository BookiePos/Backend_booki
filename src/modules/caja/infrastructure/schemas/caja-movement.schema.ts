import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  CAJA_MOVEMENT_TYPES,
  CajaMovementType,
} from '../../domain/caja.constants';

export type CajaMovementDocument = HydratedDocument<CajaMovement>;

/** Movimiento manual de efectivo dentro de un turno de caja. */
@Schema({ timestamps: true, collection: 'caja_movements' })
export class CajaMovement {
  @Prop({ type: Types.ObjectId, ref: 'CajaSession', required: true, index: true })
  sessionId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true, enum: CAJA_MOVEMENT_TYPES })
  type!: CajaMovementType;

  /** Monto en pesos (siempre positivo; el tipo define el signo). */
  @Prop({ required: true, min: 0 })
  amount!: number;

  @Prop({ trim: true })
  reason?: string;

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true })
  userEmail!: string;
}

export const CajaMovementSchema = SchemaFactory.createForClass(CajaMovement);

CajaMovementSchema.index({ sessionId: 1, createdAt: -1 });
