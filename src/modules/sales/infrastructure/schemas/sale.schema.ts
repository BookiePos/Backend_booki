import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  PAYMENT_METHODS,
  PaymentMethod,
  SALE_STATUSES,
  SaleStatus,
} from '../../domain/sales.constants';

export type SaleDocument = HydratedDocument<Sale>;

/** Porción de lote consumida por una línea (costo de venta / trazabilidad). */
@Schema({ _id: false })
class SaleConsumedLot {
  @Prop({ type: Types.ObjectId, ref: 'StockLot' })
  lotId?: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  qty!: number;

  @Prop({ default: 0, min: 0 })
  unitCost!: number;
}
const SaleConsumedLotSchema = SchemaFactory.createForClass(SaleConsumedLot);

/** Línea de venta: snapshot del producto vendible del catálogo (POS). */
@Schema({ _id: false })
class SaleLine {
  /** Producto de catálogo vendido (lo que ve el cliente en el recibo). */
  @Prop({ type: Types.ObjectId, ref: 'CatalogProduct', required: true })
  productId!: Types.ObjectId;

  @Prop({ required: true })
  sku!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  unit!: string;

  @Prop({ required: true, min: 0 })
  qty!: number;

  /** Precio unitario al momento de la venta (siempre del servidor). */
  @Prop({ required: true, min: 0 })
  unitPrice!: number;

  @Prop({ required: true, min: 0 })
  lineTotal!: number;

  /** Vestigial: la trazabilidad de lotes vive ahora en `components`. */
  @Prop({ type: [SaleConsumedLotSchema], default: [] })
  consumedLots!: SaleConsumedLot[];
}
const SaleLineSchema = SchemaFactory.createForClass(SaleLine);

/**
 * Consumo de inventario que generó la venta (ítem directo o ingredientes de
 * las recetas, agregado por ítem). Guarda el costo real (FEFO) para el COGS.
 */
@Schema({ _id: false })
class SaleComponent {
  /** Ítem de inventario descontado. */
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ required: true })
  sku!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  unit!: string;

  /** Cantidad total descontada del inventario. */
  @Prop({ required: true, min: 0 })
  qty!: number;

  /** Costo real de lo consumido (Σ qty × unitCost de los lotes). */
  @Prop({ default: 0, min: 0 })
  cost!: number;

  @Prop({ type: [SaleConsumedLotSchema], default: [] })
  consumedLots!: SaleConsumedLot[];
}
const SaleComponentSchema = SchemaFactory.createForClass(SaleComponent);

@Schema({ _id: false })
class SalePayment {
  @Prop({ required: true, enum: PAYMENT_METHODS })
  method!: PaymentMethod;

  /** Monto recibido (efectivo). */
  @Prop({ min: 0 })
  received?: number;

  @Prop({ min: 0 })
  change?: number;
}
const SalePaymentSchema = SchemaFactory.createForClass(SalePayment);

/** Venta del POS. Documento único y atómico (Mongo standalone). */
@Schema({ timestamps: true, collection: 'sales' })
export class Sale {
  /** Consecutivo por sede, ej. "CENTRO-000123". */
  @Prop({ required: true, trim: true })
  saleNumber!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true })
  cashierId!: string;

  @Prop({ required: true })
  cashierEmail!: string;

  @Prop({ required: true, enum: SALE_STATUSES, default: 'completed' })
  status!: SaleStatus;

  @Prop({ type: [SaleLineSchema], required: true })
  lines!: SaleLine[];

  /** Salidas de inventario que originó la venta (para stock y costo). */
  @Prop({ type: [SaleComponentSchema], default: [] })
  components!: SaleComponent[];

  @Prop({ required: true, min: 0 })
  subtotal!: number;

  /** Impuestos: 0 hasta que exista el módulo de impuestos. */
  @Prop({ default: 0, min: 0 })
  taxTotal!: number;

  @Prop({ required: true, min: 0 })
  total!: number;

  @Prop({ type: SalePaymentSchema, required: true })
  payment!: SalePayment;

  /** Turno de caja; se llenará cuando exista el módulo de Caja. */
  @Prop({ type: Types.ObjectId })
  cajaSessionId?: Types.ObjectId;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);

SaleSchema.index({ sedeId: 1, saleNumber: 1 }, { unique: true });
SaleSchema.index({ sedeId: 1, createdAt: -1 });
