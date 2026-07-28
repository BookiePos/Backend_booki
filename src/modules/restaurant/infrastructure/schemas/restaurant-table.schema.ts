import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TABLE_STATUSES, TableStatus } from '../../domain/restaurant.constants';

export type RestaurantTableDocument = HydratedDocument<RestaurantTable>;

/** Mesa de un salón dentro de una sede. */
@Schema({ timestamps: true, collection: 'restaurant_tables' })
export class RestaurantTable {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  /** Salón/zona (Principal, Terraza, Segundo piso…). */
  @Prop({ required: true, trim: true, default: 'Principal' })
  zone!: string;

  @Prop({ default: 4, min: 1 })
  seats!: number;

  @Prop({ required: true, enum: TABLE_STATUSES, default: 'free' })
  status!: TableStatus;

  /** Comanda abierta actualmente en la mesa, si la hay. */
  @Prop({ type: Types.ObjectId, ref: 'RestaurantOrder', default: null })
  currentOrderId?: Types.ObjectId | null;

  @Prop({ default: true })
  active!: boolean;
}

export const RestaurantTableSchema =
  SchemaFactory.createForClass(RestaurantTable);

RestaurantTableSchema.index({ sedeId: 1, zone: 1, name: 1 });
