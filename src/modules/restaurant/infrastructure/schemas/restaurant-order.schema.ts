import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  ORDER_STATUSES,
  RestaurantOrderStatus,
} from '../../domain/restaurant.constants';

/** Ítem de una comanda. */
@Schema({ _id: true })
export class OrderItem {
  @Prop({ type: Types.ObjectId, ref: 'CatalogProduct' })
  productId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, min: 1 })
  qty!: number;

  @Prop({ required: true, min: 0 })
  unitPrice!: number;

  @Prop({ trim: true })
  note?: string;

  /** Estación de cocina donde se prepara. */
  @Prop({ trim: true })
  station?: string;

  /** Ya se envió a cocina (para no reimprimir la comanda). */
  @Prop({ default: false })
  sentToKitchen!: boolean;
}
const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

export type RestaurantOrderDocument = HydratedDocument<RestaurantOrder>;

/**
 * Comanda / cuenta de una mesa. Totales: subtotal + INC + propina.
 * La propina es un pasivo voluntario, rechazable por el cliente
 * (`tipAccepted=false` ⇒ `tipAmount=0`).
 */
@Schema({ timestamps: true, collection: 'restaurant_orders' })
export class RestaurantOrder {
  @Prop({ required: true, unique: true, trim: true })
  number!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'RestaurantTable', required: true })
  tableId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  tableName!: string;

  @Prop({ trim: true })
  zone?: string;

  @Prop({ default: 1, min: 1 })
  guests!: number;

  @Prop({
    required: true,
    enum: ORDER_STATUSES,
    default: 'open',
    index: true,
  })
  status!: RestaurantOrderStatus;

  @Prop({ type: [OrderItemSchema], default: [] })
  items!: OrderItem[];

  @Prop({ default: 0, min: 0 })
  subtotal!: number;

  @Prop({ default: 8, min: 0 })
  incRate!: number;

  @Prop({ default: 0, min: 0 })
  incAmount!: number;

  @Prop({ default: 10, min: 0 })
  tipRate!: number;

  @Prop({ default: true })
  tipAccepted!: boolean;

  @Prop({ default: 0, min: 0 })
  tipAmount!: number;

  @Prop({ default: 0, min: 0 })
  total!: number;

  @Prop({ required: true, trim: true })
  waiterEmail!: string;

  @Prop()
  sentAt?: Date;

  @Prop()
  billedAt?: Date;

  @Prop()
  closedAt?: Date;

  @Prop({ trim: true })
  cancelReason?: string;
}

export const RestaurantOrderSchema =
  SchemaFactory.createForClass(RestaurantOrder);

RestaurantOrderSchema.index({ sedeId: 1, status: 1 });
RestaurantOrderSchema.index({ createdAt: -1 });
