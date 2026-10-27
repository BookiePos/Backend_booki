import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type OfflineConflictDocument = HydratedDocument<OfflineConflictRecord>;

/**
 * Bandeja de conflictos offline en el servidor (ítem 6.3).
 *
 * Cuando una venta cobrada sin red no se puede registrar al sincronizar, el
 * terminal la guarda en su IndexedDB. Esa copia se pierde si se borra el
 * navegador, así que el servidor guarda también el conflicto con la venta
 * completa: quien tenga permiso de autorizar anulaciones lo ve por sede y
 * puede registrarla con lo cobrado. `_id` es el UUID de la venta.
 */
@Schema({ timestamps: true, collection: 'offline_conflicts' })
export class OfflineConflictRecord {
  @Prop({ type: String })
  _id!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true })
  saleNumber!: string;

  @Prop({ required: true })
  reason!: string;

  @Prop({ required: true })
  message!: string;

  @Prop({ required: true })
  userId!: string;

  @Prop()
  userEmail?: string;

  @Prop()
  soldAt?: Date;

  @Prop({ min: 0 })
  expectedGrandTotal?: number;

  /** El cuerpo de la sincronización tal cual, para poder reintentarla. */
  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ required: true, enum: ['abierto', 'resuelto'], default: 'abierto' })
  status!: 'abierto' | 'resuelto';

  @Prop({ type: Types.ObjectId })
  saleId?: Types.ObjectId;

  @Prop()
  resolvedById?: string;

  @Prop()
  resolvedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OfflineConflictSchema = SchemaFactory.createForClass(OfflineConflictRecord);

OfflineConflictSchema.index({ sedeId: 1, status: 1, updatedAt: -1 });
