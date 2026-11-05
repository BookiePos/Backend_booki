import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { SetHabilitacionNe } from '../../domain/nomina/set-habilitacion';

export type PayrollHabilitacionDocument = HydratedDocument<PayrollHabilitacion>;

/**
 * Estado del set de pruebas de la nómina electrónica de UN emisor. Colección
 * aparte de `payroll_e_documents`: los documentos de prueba (trabajador
 * sintético, prefijos NEP/NAP) jamás se mezclan con la nómina real.
 */
@Schema({ timestamps: true, collection: 'payroll_habilitaciones' })
export class PayrollHabilitacion {
  @Prop({ type: Types.ObjectId, ref: 'FiscalEmitter', required: true })
  emisorId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true })
  sedeId!: Types.ObjectId;

  /** El set tal cual (documentos, estados, trackIds). Sin XML ni secretos. */
  @Prop({ type: Object, required: true })
  conjunto!: SetHabilitacionNe;

  /** Una sola corrida a la vez por emisor (evita enviar dos veces el mismo documento). */
  @Prop({ type: String })
  bloqueo?: string;

  @Prop({ type: Date })
  bloqueoHasta?: Date;
}

export const PayrollHabilitacionSchema = SchemaFactory.createForClass(PayrollHabilitacion);
PayrollHabilitacionSchema.index({ emisorId: 1 }, { unique: true, name: 'nomina_habilitacion_un_set_por_emisor' });
