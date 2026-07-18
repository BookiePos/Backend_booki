import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type StockItemDocument = HydratedDocument<StockItem>;

/**
 * Existencia consolidada de un producto en una sede.
 * Es la "foto" actual; el detalle histórico vive en StockMovement
 * y el detalle por lote en StockLot.
 */
@Schema({ timestamps: true, collection: 'stock_items' })
export class StockItem {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true, default: 0 })
  qty!: number;

  /** Stock mínimo específico de esta sede (si no, aplica el del producto). */
  @Prop({ min: 0 })
  minStock?: number;
}

export const StockItemSchema = SchemaFactory.createForClass(StockItem);

StockItemSchema.index({ productId: 1, sedeId: 1 }, { unique: true });
StockItemSchema.index({ sedeId: 1 });
