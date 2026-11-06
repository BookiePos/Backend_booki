import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TIPOS_NOVEDAD, type TipoNovedad } from '../../domain/novedades-calc';

export type PayrollNovedadDocument = HydratedDocument<PayrollNovedad>;

/**
 * Novedad de ausencia de un empleado (decisión 3 del dueño, tarea 11):
 * vacaciones disfrutadas, incapacidad o licencia, con su rango de fechas. La
 * corrida del mes la liquida (`liquidarAusencias`) y la nómina electrónica la
 * reporta en su nodo. No se edita: se anula y se registra otra.
 */
@Schema({ timestamps: true, collection: 'payroll_novedades' })
export class PayrollNovedad {
  @Prop({ required: true, index: true })
  employeeId!: string;

  @Prop({ trim: true })
  employeeName?: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  @Prop({ required: true, enum: TIPOS_NOVEDAD as unknown as string[] })
  tipo!: TipoNovedad;

  /** YYYY-MM-DD, ambos incluidos. */
  @Prop({ required: true, index: true })
  fechaInicio!: string;

  @Prop({ required: true, index: true })
  fechaFin!: string;

  /** Incapacidad común: días ya incapacitados antes (prórroga). */
  @Prop()
  diasPreviosProrroga?: number;

  /** Vacaciones: días hábiles disfrutados. */
  @Prop()
  diasHabiles?: number;

  @Prop({ trim: true })
  observacion?: string;

  @Prop({ required: true, default: 'activa', enum: ['activa', 'anulada'] })
  estado!: 'activa' | 'anulada';

  @Prop({ trim: true })
  creadaPor?: string;

  @Prop({ trim: true })
  anuladaPor?: string;

  @Prop()
  anuladaEn?: Date;
}

export const PayrollNovedadSchema = SchemaFactory.createForClass(PayrollNovedad);
PayrollNovedadSchema.index({ employeeId: 1, estado: 1, fechaInicio: 1 });
