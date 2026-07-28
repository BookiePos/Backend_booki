import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  MOVEMENT_DIRECTIONS,
  MovementDirection,
} from '../../domain/finance.constants';

export type FinanceMovementDocument = HydratedDocument<FinanceMovement>;

/**
 * Movimiento de una cuenta de tesorería (entrada/salida). El saldo de la cuenta
 * se deriva de estos. Monto en COP entero (siempre positivo; `direction` fija
 * el signo).
 */
@Schema({ timestamps: true, collection: 'finance_movements' })
export class FinanceMovement {
  @Prop({ type: Types.ObjectId, ref: 'FinanceAccount', required: true, index: true })
  accountId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Sede', default: null })
  sedeId?: Types.ObjectId | null;

  /** Fecha del movimiento YYYY-MM-DD. */
  @Prop({ required: true, trim: true })
  date!: string;

  @Prop({ required: true, enum: MOVEMENT_DIRECTIONS })
  direction!: MovementDirection;

  @Prop({ required: true, min: 0 })
  amount!: number;

  @Prop({ type: Types.ObjectId, ref: 'FinanceCategory' })
  categoryId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  concept!: string;

  @Prop({ default: false })
  reconciled!: boolean;

  @Prop({ required: true, trim: true })
  createdByEmail!: string;
}

export const FinanceMovementSchema =
  SchemaFactory.createForClass(FinanceMovement);

FinanceMovementSchema.index({ accountId: 1, date: -1 });
