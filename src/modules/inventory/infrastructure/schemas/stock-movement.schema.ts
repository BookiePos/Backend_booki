import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { MOVEMENT_TYPES, MovementType } from '../../domain/inventory.constants';

export type StockMovementDocument = HydratedDocument<StockMovement>;

/**
 * Kardex: registro inmutable de cada movimiento de inventario.
 */
@Schema({ timestamps: true, collection: 'stock_movements' })
export class StockMovement {
  @Prop({ required: true, enum: MOVEMENT_TYPES })
  type!: MovementType;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'StockLot' })
  lotId?: Types.ObjectId;

  /** Cambio aplicado al stock (positivo entra, negativo sale). */
  @Prop({ required: true })
  delta!: number;

  /** Saldo del producto en la sede después del movimiento. */
  @Prop({ required: true })
  balanceAfter!: number;

  @Prop({ min: 0 })
  unitCost?: number;

  /** Razón (para ajustes y mermas). */
  @Prop({ trim: true })
  reason?: string;

  @Prop({ trim: true })
  note?: string;

  /** Agrupa los dos movimientos de un traslado (salida + entrada). */
  @Prop({ trim: true })
  transferGroupId?: string;

  @Prop({ required: true })
  userId!: string;

  @Prop({ trim: true })
  userEmail?: string;
}

export const StockMovementSchema = SchemaFactory.createForClass(StockMovement);

StockMovementSchema.index({ sedeId: 1, createdAt: -1 });
StockMovementSchema.index({ productId: 1, sedeId: 1, createdAt: -1 });
