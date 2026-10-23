import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type OfflineSaleClaimDocument = HydratedDocument<OfflineSaleClaim>;

/**
 * Candado de idempotencia de la sincronización offline (ítem 6.3).
 *
 * `_id` es el UUID que el terminal le puso a la venta. Se inserta ANTES de
 * tocar inventario: un reintento (o dos pestañas sincronizando a la vez) choca
 * con el índice único y no vuelve a vender. El índice (sede, número) impide
 * además que dos ventas distintas usen el mismo consecutivo reservado.
 *
 * Si el registro falla con un conflicto, el candado se borra para que la venta
 * pueda reintentarse desde la bandeja con el mismo UUID.
 */
@Schema({ timestamps: true, collection: 'offline_sale_claims' })
export class OfflineSaleClaim {
  @Prop({ type: String })
  _id!: string;

  @Prop({ type: Types.ObjectId, required: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true })
  saleNumber!: string;

  @Prop({ type: Types.ObjectId, required: true })
  reservationId!: Types.ObjectId;

  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true, enum: ['processing', 'done'], default: 'processing' })
  status!: 'processing' | 'done';

  @Prop({ type: Types.ObjectId })
  saleId?: Types.ObjectId;

  createdAt?: Date;
}

export const OfflineSaleClaimSchema =
  SchemaFactory.createForClass(OfflineSaleClaim);

OfflineSaleClaimSchema.index({ sedeId: 1, saleNumber: 1 }, { unique: true });
