import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  REFUND_METHODS,
  RESTOCK_MODES,
  RETURN_REASONS,
  RefundMethod,
  RestockMode,
  ReturnReason,
} from '../../domain/sale-return';

/** Una línea devuelta, con lo que se le reembolsó por ella. */
@Schema({ _id: false })
export class SaleReturnLine {
  @Prop({ type: Types.ObjectId, ref: 'CatalogProduct', required: true })
  productId!: Types.ObjectId;

  /** Snapshot legible: el catálogo puede cambiar después. */
  @Prop({ required: true })
  sku!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true, min: 0 })
  qty!: number;

  /** Lo que se le devolvió por esta línea, con IVA incluido. */
  @Prop({ required: true, min: 0 })
  refund!: number;

  /** Parte de ese reembolso que es IVA. */
  @Prop({ default: 0, min: 0 })
  refundTax!: number;
}

const SaleReturnLineSchema = SchemaFactory.createForClass(SaleReturnLine);

export type SaleReturnDocument = HydratedDocument<SaleReturn>;

/**
 * Devolución parcial de una venta.
 *
 * Es un documento aparte y no un cambio sobre la venta: la venta ya ocurrió y
 * es un hecho, igual que un asiento del libro. Lo que vuelve se registra
 * encima, con su fecha, su motivo y quién lo autorizó. Así una venta puede
 * tener varias devoluciones y el historial no se pisa.
 */
@Schema({ timestamps: true, collection: 'sale_returns' })
export class SaleReturn {
  @Prop({ type: Types.ObjectId, ref: 'Sale', required: true, index: true })
  saleId!: Types.ObjectId;

  /** Número de la venta, copiado para poder buscar sin cruzar colecciones. */
  @Prop({ required: true, trim: true })
  saleNumber!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: [SaleReturnLineSchema], required: true })
  lines!: SaleReturnLine[];

  @Prop({ required: true, enum: RETURN_REASONS })
  reason!: ReturnReason;

  /**
   * Qué se hizo con la mercancía. `inventory` la devuelve al estante;
   * `waste` la registra como merma, porque volvió pero ya no se puede vender.
   */
  @Prop({ required: true, enum: RESTOCK_MODES })
  restock!: RestockMode;

  /**
   * Si la merma alcanzó a registrarse. Solo importa cuando `restock` es
   * `waste`: la mercancía vuelve al inventario y se da de baja en un segundo
   * paso, y si ese paso falla queda existencia de más, visible y corregible.
   */
  @Prop({ default: false })
  wasteRecorded!: boolean;

  @Prop({ required: true, enum: REFUND_METHODS })
  refundMethod!: RefundMethod;

  /** Lo que se le devolvió al cliente en total, con IVA. */
  @Prop({ required: true, min: 0 })
  refundTotal!: number;

  /** IVA contenido en ese reembolso (para reversarlo en el libro). */
  @Prop({ default: 0, min: 0 })
  refundTax!: number;

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true, trim: true })
  userEmail!: string;
}

export const SaleReturnSchema = SchemaFactory.createForClass(SaleReturn);

SaleReturnSchema.index({ sedeId: 1, createdAt: -1 });
