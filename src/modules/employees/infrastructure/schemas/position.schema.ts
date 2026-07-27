import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PositionDocument = HydratedDocument<Position>;

/**
 * Cargo / puesto de trabajo del negocio (Cajero, Cocinero, Mesero…). Catálogo
 * administrable que se asigna a cada empleado.
 */
@Schema({ timestamps: true, collection: 'positions' })
export class Position {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ default: true })
  active!: boolean;
}

export const PositionSchema = SchemaFactory.createForClass(Position);

PositionSchema.index({ name: 1 }, { unique: true });
