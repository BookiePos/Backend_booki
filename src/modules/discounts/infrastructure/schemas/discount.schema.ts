import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DISCOUNT_TYPES, DiscountKind } from '../../domain/discount.constants';

export type DiscountDocument = HydratedDocument<Discount>;

/**
 * Descuento predefinido de una sede. Se aplican por línea de producto en el POS
 * (quien lo aplica requiere `pos.discount.authorize`). Al venderse se guarda un
 * snapshot en la línea de venta, así que borrar un descuento no afecta ventas
 * pasadas.
 */
@Schema({ timestamps: true, collection: 'discounts' })
export class Discount {
  /** Sede dueña del descuento (los descuentos son por sede). */
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  /** 'percent' = % del precio de la línea; 'amount' = monto fijo en pesos. */
  @Prop({ required: true, enum: DISCOUNT_TYPES })
  type!: DiscountKind;

  @Prop({ required: true, min: 0 })
  value!: number;

  @Prop({ default: true })
  active!: boolean;
}

export const DiscountSchema = SchemaFactory.createForClass(Discount);
