import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  OPERACIONES_CONCILIACION,
  type OperacionConciliacion,
} from '../../domain/conciliacion';

export type LedgerPendienteDocument = HydratedDocument<LedgerPendiente>;

/**
 * Asiento que el sistema no pudo escribir (o reversar) y quedó por conciliar.
 * El posteo automático es best-effort —la venta o el gasto no se tumban por el
 * libro—, así que este registro es lo que evita que el fallo pase en silencio.
 * Vive en la base de cada empresa. Lo resuelve el script de reconstrucción
 * (`src/datos/2026-10-reconstruir-asientos.ts`).
 */
@Schema({ timestamps: true, collection: 'ledger_conciliacion_pendientes' })
export class LedgerPendiente {
  @Prop({ required: true, trim: true })
  sourceType!: string;

  @Prop({ required: true, trim: true })
  sourceId!: string;

  @Prop({ type: String, required: true, enum: OPERACIONES_CONCILIACION })
  operacion!: OperacionConciliacion;

  /** Último mensaje de error. */
  @Prop({ required: true })
  error!: string;

  /** Veces que falló la misma operación sobre el mismo origen. */
  @Prop({ required: true, min: 1 })
  intentos!: number;

  @Prop({ type: Date, required: true })
  ultimoFallo!: Date;

  @Prop({ default: false })
  resuelto!: boolean;

  @Prop({ type: Date, default: null })
  resueltoEn?: Date | null;
}

export const LedgerPendienteSchema = SchemaFactory.createForClass(LedgerPendiente);

// Un solo pendiente abierto por (origen, operación): un fallo repetido suma
// intentos en vez de llenar la colección.
LedgerPendienteSchema.index(
  { sourceType: 1, sourceId: 1, operacion: 1 },
  { unique: true, partialFilterExpression: { resuelto: false } },
);
LedgerPendienteSchema.index({ resuelto: 1, ultimoFallo: -1 });
