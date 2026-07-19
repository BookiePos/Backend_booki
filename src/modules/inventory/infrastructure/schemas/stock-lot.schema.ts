import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type StockLotDocument = HydratedDocument<StockLot>;

/**
 * Lote de un producto en una sede. Las salidas consumen lotes en orden
 * FEFO (primero el que vence primero; los lotes sin vencimiento, al final).
 */
@Schema({ timestamps: true, collection: 'stock_lots' })
export class StockLot {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true })
  sedeId!: Types.ObjectId;

  /** Código de lote del proveedor o generado internamente. */
  @Prop({ required: true, trim: true })
  lotCode!: string;

  /** Proveedor del que ingresó el lote. */
  @Prop({ trim: true })
  supplier?: string;

  @Prop()
  expiresAt?: Date;

  /** Cantidad restante del lote. */
  @Prop({ required: true, min: 0 })
  qty!: number;

  /** Cantidad con la que ingresó el lote. */
  @Prop({ required: true, min: 0 })
  initialQty!: number;

  @Prop({ default: 0, min: 0 })
  unitCost!: number;

  @Prop({ required: true, default: () => new Date() })
  receivedAt!: Date;
}

export const StockLotSchema = SchemaFactory.createForClass(StockLot);

StockLotSchema.index({ productId: 1, sedeId: 1, expiresAt: 1 });
StockLotSchema.index({ sedeId: 1, expiresAt: 1 });
