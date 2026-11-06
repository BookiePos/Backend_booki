import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type NotaSinReferenciaDocument = HydratedDocument<NotaSinReferencia>;

/**
 * Descuento posterior SIN referencia a una factura (Fase 6C): volumen o pronto
 * pago sobre las FEV de un cliente en un periodo (CustomizationID 22). Es la
 * operación que mueve caja y libro; su nota crédito vive en facturación.
 *
 * Pasos como la devolución: nace `en_curso` con la nota ya emitida (falla
 * cerrado) y pasa a `completa` cuando quedan la salida de caja y el asiento.
 */
@Schema({ timestamps: true, collection: 'notas_sin_referencia' })
export class NotaSinReferencia {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true, index: true })
  customerId!: Types.ObjectId;

  /** Nombre y documento del cliente, copiados para leer sin cruzar colecciones. */
  @Prop({ trim: true })
  customerName?: string;

  @Prop({ required: true, trim: true })
  docNumber!: string;

  @Prop({ type: String, required: true, enum: ['3', '4', '5', '6'] })
  concepto!: '3' | '4' | '5' | '6';

  @Prop({ required: true })
  desde!: string;

  @Prop({ required: true })
  hasta!: string;

  /** Lo acreditado, con impuesto. */
  @Prop({ required: true, min: 0 })
  amount!: number;

  /** IVA (2408) e INC (2495) que reversa, según el reparto de la nota. */
  @Prop({ default: 0, min: 0 })
  iva!: number;

  @Prop({ default: 0, min: 0 })
  inc!: number;

  @Prop({ type: String, required: true, enum: ['cash', 'transfer', 'credit_note'] })
  refundMethod!: 'cash' | 'transfer' | 'credit_note';

  @Prop({ required: true, trim: true })
  reason!: string;

  @Prop({ required: true, trim: true })
  idempotencyKey!: string;

  @Prop({ type: String, enum: ['en_curso', 'pendiente_caja', 'completa'], default: 'en_curso' })
  estado!: 'en_curso' | 'pendiente_caja' | 'completa';

  /** Turno de quien la completa: otra petición con la misma llave espera (409). */
  @Prop({ type: Date, default: null })
  procesandoHasta?: Date | null;

  @Prop({ default: false })
  cajaHecha!: boolean;

  @Prop({ default: false })
  asientoHecho!: boolean;

  /** La nota crédito emitida (`NotaFiscalOperacion`). */
  @Prop({ type: Object })
  notaFiscal?: Record<string, unknown>;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true, trim: true })
  userEmail!: string;
}

export const NotaSinReferenciaSchema = SchemaFactory.createForClass(NotaSinReferencia);

// Una operación por llave: el reintento no descuenta dos veces.
NotaSinReferenciaSchema.index(
  { idempotencyKey: 1 },
  { name: 'nota_sin_referencia_idempotente', unique: true },
);
// Alerta de notas colgadas y barrido.
NotaSinReferenciaSchema.index({ estado: 1, createdAt: 1 });
