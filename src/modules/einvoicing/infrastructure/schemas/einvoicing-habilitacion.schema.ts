import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { SetHabilitacion } from '../../domain/habilitacion/set-habilitacion-factura';

export type EinvoicingHabilitacionDocument = HydratedDocument<EinvoicingHabilitacion>;

/**
 * Estado del set de pruebas de HABILITACIÓN de la factura (`fe`) o del POS
 * (`pos`) de UN emisor. Colección aparte de `electronic_documents`: los
 * documentos de prueba (resolución SETP, adquiriente de prueba) jamás se
 * mezclan con la facturación real.
 */
@Schema({ timestamps: true, collection: 'einvoicing_habilitaciones' })
export class EinvoicingHabilitacion {
  @Prop({ type: Types.ObjectId, ref: 'FiscalEmitter', required: true })
  emisorId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: String, enum: ['fe', 'pos'], required: true })
  clase!: string;

  /** El set tal cual (documentos, estados, trackIds). Sin XML ni secretos. */
  @Prop({ type: Object, required: true })
  conjunto!: SetHabilitacion;

  /** Una sola corrida a la vez por emisor y clase (evita enviar dos veces el mismo documento). */
  @Prop({ type: String })
  bloqueo?: string;

  @Prop({ type: Date })
  bloqueoHasta?: Date;
}

export const EinvoicingHabilitacionSchema = SchemaFactory.createForClass(EinvoicingHabilitacion);
EinvoicingHabilitacionSchema.index(
  { emisorId: 1, clase: 1 },
  { unique: true, name: 'einvoicing_habilitacion_un_set_por_emisor_y_clase' },
);
