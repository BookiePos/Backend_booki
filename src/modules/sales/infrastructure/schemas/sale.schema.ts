import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  DISCOUNT_TYPES,
  DiscountType,
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

  /** Bruto de la línea: qty × unitPrice, antes de descuento. */
  @Prop({ required: true, min: 0 })
  lineTotal!: number;

  /** Descuento aplicado a esta línea (0 si ninguno). Neto = lineTotal − esto. */
  @Prop({ default: 0, min: 0 })
  discountAmount!: number;

  /** Nombre del descuento aplicado (snapshot para el recibo). */
  @Prop({ trim: true })
  discountName?: string;

  /** Tarifa de IVA aplicada a la línea (0/5/19). El precio ya la incluye. */
  @Prop({ default: 0, min: 0 })
  ivaRate!: number;

  /** Base gravable de la línea (neto sin IVA), para la factura electrónica. */
  @Prop({ default: 0, min: 0 })
  taxBase!: number;

  /** IVA de la línea (incluido en el precio), para la factura electrónica. */
  @Prop({ default: 0, min: 0 })
  taxAmount!: number;

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

/** Descuento aplicado a la venta (descriptor + monto resuelto). */
@Schema({ _id: false })
class SaleDiscount {
  @Prop({ required: true, enum: DISCOUNT_TYPES })
  type!: DiscountType;

  /** Valor pedido: pesos (amount) o porcentaje (percent). */
  @Prop({ required: true, min: 0 })
  value!: number;

  /** Monto de descuento efectivamente aplicado (en pesos). */
  @Prop({ required: true, min: 0 })
  amount!: number;
}
const SaleDiscountSchema = SchemaFactory.createForClass(SaleDiscount);

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

/** Datos del cliente para la factura (todos opcionales). */
@Schema({ _id: false })
class SaleCustomer {
  @Prop({ trim: true })
  name?: string;

  /** Cédula / NIT del cliente. */
  @Prop({ trim: true })
  idNumber?: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ trim: true })
  email?: string;
}
const SaleCustomerSchema = SchemaFactory.createForClass(SaleCustomer);

/** Venta del POS. Documento único y atómico (Mongo standalone). */
@Schema({ timestamps: true, collection: 'sales' })
export class Sale {
  /** Consecutivo por sede, ej. "FV-000123". */
  @Prop({ required: true, trim: true })
  saleNumber!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true })
  cashierId!: string;

  @Prop({ required: true })
  cashierEmail!: string;

  /** Nombre del cajero al momento de la venta (encabezado de factura). */
  @Prop({ trim: true })
  cashierName?: string;

  @Prop({ required: true, enum: SALE_STATUSES, default: 'completed' })
  status!: SaleStatus;

  @Prop({ type: [SaleLineSchema], required: true })
  lines!: SaleLine[];

  /** Salidas de inventario que originó la venta (para stock y costo). */
  @Prop({ type: [SaleComponentSchema], default: [] })
  components!: SaleComponent[];

  @Prop({ required: true, min: 0 })
  subtotal!: number;

  /** Descuento aplicado (opcional). */
  @Prop({ type: SaleDiscountSchema })
  discount?: SaleDiscount;

  /** Monto total de descuento (0 si no hubo). */
  @Prop({ default: 0, min: 0 })
  discountTotal!: number;

  /** Base gravable total (Σ bases de línea sin IVA). */
  @Prop({ default: 0, min: 0 })
  taxableBase!: number;

  /** IVA total (incluido en los precios). Informativo para la factura. */
  @Prop({ default: 0, min: 0 })
  taxTotal!: number;

  @Prop({ required: true, min: 0 })
  total!: number;

  @Prop({ type: SalePaymentSchema, required: true })
  payment!: SalePayment;

  /** Datos del cliente para la factura (opcional). */
  @Prop({ type: SaleCustomerSchema })
  customer?: SaleCustomer;

  /** Turno de caja; se llenará cuando exista el módulo de Caja. */
  @Prop({ type: Types.ObjectId })
  cajaSessionId?: Types.ObjectId;

  /** Cuenta abierta que originó la venta (si se liquidó una cuenta). */
  @Prop({ type: Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);

SaleSchema.index({ sedeId: 1, saleNumber: 1 }, { unique: true });
SaleSchema.index({ sedeId: 1, createdAt: -1 });
