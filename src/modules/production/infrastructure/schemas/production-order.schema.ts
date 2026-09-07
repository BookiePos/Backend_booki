import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  PRODUCTION_ORDER_STATUSES,
  ProductionOrderStatus,
} from '../../domain/production.constants';

/** Insumo planificado de una orden (explosión de la receta al crearla). */
@Schema({ _id: false })
export class ProductionLine {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  /** Nombre y SKU congelados: la orden debe leerse igual dentro de un año. */
  @Prop({ required: true, trim: true })
  description!: string;

  @Prop({ required: true, trim: true })
  unit!: string;

  /** Cantidad planificada a consumir. */
  @Prop({ required: true, min: 0 })
  qty!: number;

  /**
   * Cantidad efectivamente descontada del stock. Es la marca de idempotencia
   * del cierre: se reserva ANTES de tocar el inventario, así un reintento tras
   * un fallo a mitad de camino no vuelve a consumir el insumo.
   */
  @Prop({ default: 0, min: 0 })
  qtyConsumed!: number;

  /** Costo unitario REAL de los lotes consumidos (se llena al cerrar). */
  @Prop({ default: 0, min: 0 })
  unitCost!: number;

  @Prop({ default: 0, min: 0 })
  subtotal!: number;
}
const ProductionLineSchema = SchemaFactory.createForClass(ProductionLine);

export type ProductionOrderDocument = HydratedDocument<ProductionOrder>;

/**
 * Orden de producción: consume insumos de una sede y devuelve un terminado a
 * esa misma sede.
 *
 * El terminado entra con su propio lote y con el costo del batch —materiales
 * consumidos a costo real de lote, más el costo de conversión— repartido entre
 * las unidades que salieron. Se guarda `producedQty` aparte de `plannedQty`
 * porque casi nunca coinciden: se planean 120 panes y salen 114, y es esa
 * diferencia la que revela la merma del proceso.
 */
@Schema({ timestamps: true, collection: 'production_orders' })
export class ProductionOrder {
  /** Consecutivo legible (OP-000001). */
  @Prop({ required: true, unique: true, trim: true })
  number!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({
    required: true,
    enum: PRODUCTION_ORDER_STATUSES,
    default: 'draft',
    index: true,
  })
  status!: ProductionOrderStatus;

  /** Fecha de la orden en YYYY-MM-DD (fecha local del negocio, no UTC). */
  @Prop({ required: true, trim: true })
  date!: string;

  /** Receta de la que salió la explosión, si se usó una. */
  @Prop({ type: Types.ObjectId, ref: 'BillOfMaterials' })
  bomId?: Types.ObjectId;

  // ── Terminado ──────────────────────────────────────────────────────────────
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true, index: true })
  productId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  productName!: string;

  @Prop({ required: true, trim: true })
  unit!: string;

  @Prop({ required: true, min: 0 })
  plannedQty!: number;

  /** Salida real. Reservada atómicamente antes de ingresar el terminado. */
  @Prop({ default: 0, min: 0 })
  producedQty!: number;

  // ── Insumos y costos ───────────────────────────────────────────────────────
  @Prop({ type: [ProductionLineSchema], default: [] })
  lines!: ProductionLine[];

  /** Mano de obra e indirectos del lote (COP entero). */
  @Prop({ default: 0, min: 0 })
  extraCost!: number;

  /** Σ del costo real de los lotes consumidos. */
  @Prop({ default: 0, min: 0 })
  materialsCost!: number;

  @Prop({ default: 0, min: 0 })
  totalCost!: number;

  /** `totalCost / producedQty`, redondeado a peso. Es el costo del terminado. */
  @Prop({ default: 0, min: 0 })
  unitCost!: number;

  // ── Lote del terminado ─────────────────────────────────────────────────────
  @Prop({ trim: true })
  lotCode?: string;

  /** Vencimiento del terminado (obligatorio si el producto es perecedero). */
  @Prop({ trim: true })
  expiresAt?: string;

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, trim: true })
  createdByEmail!: string;

  @Prop()
  completedAt?: Date;

  @Prop({ trim: true })
  completedByEmail?: string;
}

export const ProductionOrderSchema =
  SchemaFactory.createForClass(ProductionOrder);

ProductionOrderSchema.index({ sedeId: 1, status: 1 });
ProductionOrderSchema.index({ createdAt: -1 });
