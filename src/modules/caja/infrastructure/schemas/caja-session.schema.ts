import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { CAJA_STATUSES, CajaStatus } from '../../domain/caja.constants';

export type CajaSessionDocument = HydratedDocument<CajaSession>;

/**
 * Turno de caja de una sede. Solo puede haber uno 'open' por sede a la vez.
 * Las ventas de la sede se enlazan a la sesión abierta (`cajaSessionId`).
 */
@Schema({ timestamps: true, collection: 'caja_sessions' })
export class CajaSession {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true, enum: CAJA_STATUSES, default: 'open' })
  status!: CajaStatus;

  /** Efectivo con el que se abre la caja (base = billetes + monedas). */
  @Prop({ required: true, min: 0 })
  openingAmount!: number;

  /** Desglose de la base: efectivo en billetes. */
  @Prop({ min: 0 })
  openingBills?: number;

  /** Desglose de la base: efectivo en monedas. */
  @Prop({ min: 0 })
  openingCoins?: number;

  @Prop({ required: true })
  openedById!: string;

  @Prop({ required: true })
  openedByEmail!: string;

  @Prop({ required: true })
  openedAt!: Date;

  @Prop()
  note?: string;

  // ── Cierre ─────────────────────────────────────────────────────────────────
  @Prop()
  closedAt?: Date;

  @Prop()
  closedById?: string;

  @Prop()
  closedByEmail?: string;

  /** Efectivo contado físicamente al cerrar. */
  @Prop({ min: 0 })
  countedAmount?: number;

  /** Efectivo esperado en caja según ventas y movimientos. */
  @Prop()
  expectedCash?: number;

  /** Diferencia contado − esperado (positivo sobra, negativo falta). */
  @Prop()
  difference?: number;

  // ── Totales congelados al cierre (para el historial) ────────────────────────
  @Prop()
  salesCount?: number;

  @Prop()
  salesTotal?: number;

  @Prop()
  cashSalesTotal?: number;

  @Prop()
  movementsIn?: number;

  @Prop()
  movementsOut?: number;

  @Prop()
  closeNote?: string;
}

export const CajaSessionSchema = SchemaFactory.createForClass(CajaSession);

// Índice parcial: garantiza una sola caja abierta por sede.
CajaSessionSchema.index(
  { sedeId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);
