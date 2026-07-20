import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CounterDocument = HydratedDocument<Counter>;

/**
 * Secuencias atómicas ($inc con upsert) para consecutivos, ej. `sale:<sedeId>`.
 * Funciona sin transacciones (Mongo standalone).
 */
@Schema({ collection: 'counters' })
export class Counter {
  @Prop({ type: String })
  _id!: string;

  @Prop({ required: true, default: 0 })
  seq!: number;
}

export const CounterSchema = SchemaFactory.createForClass(Counter);
