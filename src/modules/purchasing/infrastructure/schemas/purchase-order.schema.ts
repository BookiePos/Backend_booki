import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  PURCHASE_ORDER_STATUSES,
  PurchaseOrderStatus,
} from '../../domain/purchasing.constants';

/** Renglón de una orden de compra. */
@Schema({ _id: false })
export class PurchaseLine {
  /** Producto del catálogo de inventario (opcional: puede ser un ítem libre). */
  @Prop({ type: Types.ObjectId, ref: 'Product' })
  productId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  description!: string;

  @Prop({ required: true, min: 0 })
  qty!: number;

  @Prop({ default: 0, min: 0 })
  qtyReceived!: number;

  @Prop({ required: true, min: 0 })
  unitCost!: number;

  /** Código de impuesto (motor core-tax), opcional. */
  @Prop({ trim: true })
  taxCode?: string;

  @Prop({ required: true, min: 0 })
  subtotal!: number;

  @Prop({ default: 0, min: 0 })
  taxAmount!: number;
}
const PurchaseLineSchema = SchemaFactory.createForClass(PurchaseLine);

/** Renglón recibido dentro de una recepción. */
@Schema({ _id: false })
export class ReceiptLine {
  @Prop({ required: true, min: 0 })
  lineIndex!: number;

  @Prop({ required: true, min: 0 })
  qty!: number;

  @Prop({ trim: true })
  lotCode?: string;

  @Prop({ trim: true })
  expiresAt?: string;
}
const ReceiptLineSchema = SchemaFactory.createForClass(ReceiptLine);

/** Una recepción (parcial o total) de la orden. */
@Schema({ _id: false, timestamps: { createdAt: 'at', updatedAt: false } })
export class Receipt {
  @Prop({ required: true, trim: true })
  date!: string;

  @Prop({ type: [ReceiptLineSchema], required: true })
  lines!: ReceiptLine[];

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, trim: true })
  userEmail!: string;

  /** CxP generada por esta recepción, si aplica. */
  @Prop({ type: Types.ObjectId, ref: 'FinancePayable' })
  payableId?: Types.ObjectId;
}
const ReceiptSchema = SchemaFactory.createForClass(Receipt);

export type PurchaseOrderDocument = HydratedDocument<PurchaseOrder>;

/**
 * Orden de compra. Soporta recepción parcial y total; cada recepción entra al
 * inventario (StockService) y puede generar una cuenta por pagar (CxP).
 */
@Schema({ timestamps: true, collection: 'purchase_orders' })
export class PurchaseOrder {
  /** Consecutivo legible (OC-000001). */
  @Prop({ required: true, unique: true, trim: true })
  number!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Supplier' })
  supplierId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  supplierName!: string;

  @Prop({
    required: true,
    enum: PURCHASE_ORDER_STATUSES,
    default: 'draft',
    index: true,
  })
  status!: PurchaseOrderStatus;

  @Prop({ required: true, trim: true })
  issueDate!: string;

  @Prop({ trim: true })
  expectedDate?: string;

  @Prop({ type: [PurchaseLineSchema], required: true })
  lines!: PurchaseLine[];

  @Prop({ default: 0, min: 0 })
  subtotal!: number;

  @Prop({ default: 0, min: 0 })
  taxAmount!: number;

  @Prop({ default: 0, min: 0 })
  total!: number;

  @Prop({ type: [ReceiptSchema], default: [] })
  receipts!: Receipt[];

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, trim: true })
  createdByEmail!: string;
}

export const PurchaseOrderSchema = SchemaFactory.createForClass(PurchaseOrder);

PurchaseOrderSchema.index({ sedeId: 1, status: 1 });
PurchaseOrderSchema.index({ createdAt: -1 });
