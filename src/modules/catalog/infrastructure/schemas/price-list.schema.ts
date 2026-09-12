import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Un precio pactado dentro de una lista. Con `minQty` se arma el precio por
 * cantidad: la gaseosa a $2.500 desde 12 y a $2.200 desde 50 son dos filas del
 * mismo producto.
 */
@Schema({ _id: false })
export class PriceListItem {
  @Prop({ type: Types.ObjectId, ref: 'CatalogProduct', required: true })
  catalogProductId!: Types.ObjectId;

  /** Precio unitario, con IVA incluido igual que `salePrice` del catálogo. */
  @Prop({ required: true, min: 0 })
  price!: number;

  /** Desde cuántas unidades aplica. Sin valor, aplica siempre. */
  @Prop({ min: 0 })
  minQty?: number;
}

export const PriceListItemSchema = SchemaFactory.createForClass(PriceListItem);

export type PriceListDocument = HydratedDocument<PriceList>;

/**
 * Lista de precios: vender lo mismo a distinto precio según a quién.
 *
 * El `salePrice` del catálogo sigue siendo el de mostrador —lo que se cobra
 * cuando no hay lista— y una lista son las reglas que se le aplican encima.
 * Ver `domain/price-list.ts` para el orden en que se resuelven.
 */
@Schema({ timestamps: true, collection: 'price_lists' })
export class PriceList {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  description?: string;

  /**
   * Descuento general sobre el precio de mostrador (0–100).
   *
   * Existe para poder arrancar el mismo día con una sola cifra —"mayorista es
   * 12 % menos"— sin teclear trescientos precios. Los precios por producto de
   * `items` mandan sobre esto.
   */
  @Prop({ required: true, min: 0, max: 100, default: 0 })
  discountPercent!: number;

  @Prop({ type: [PriceListItemSchema], default: [] })
  items!: PriceListItem[];

  @Prop({ default: true })
  active!: boolean;
}

export const PriceListSchema = SchemaFactory.createForClass(PriceList);

PriceListSchema.index({ name: 1 });
