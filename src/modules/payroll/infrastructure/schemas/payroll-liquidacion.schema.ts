import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { LiquidacionBreakdown } from '../../domain/liquidacion-calc';

export type PayrollLiquidacionDocument = HydratedDocument<PayrollLiquidacion>;

export const LIQUIDACION_ESTADOS = ['borrador', 'aprobada', 'anulada'] as const;
export type LiquidacionEstado = (typeof LIQUIDACION_ESTADOS)[number];

/**
 * Liquidación definitiva de un contrato, guardada y aprobada (decisión 4 del
 * dueño, tarea 11). Antes era un cálculo que se devolvía y se perdía; sin el
 * registro, la nómina electrónica del mes del retiro saldría sin cesantías,
 * prima, vacaciones ni indemnización. La aprobada es la que se reporta.
 *
 * Inmutable una vez aprobada: se corrige anulándola y guardando otra.
 */
@Schema({ timestamps: true, collection: 'payroll_liquidaciones' })
export class PayrollLiquidacion {
  @Prop({ required: true, index: true })
  employeeId!: string;

  @Prop({ trim: true })
  employeeName?: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  /** Fecha de ingreso que usó el cálculo (YYYY-MM-DD). */
  @Prop({ required: true })
  fechaInicio!: string;

  /** Fecha de retiro (YYYY-MM-DD). */
  @Prop({ required: true, index: true })
  fechaRetiro!: string;

  @Prop({ required: true })
  motivo!: string;

  @Prop({ trim: true })
  contractType?: string;

  @Prop({ required: true })
  salarioBase!: number;

  @Prop({ required: true, default: 'ordinario' })
  salaryType!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  breakdown!: LiquidacionBreakdown;

  @Prop({ required: true, default: 'borrador', enum: LIQUIDACION_ESTADOS as unknown as string[] })
  estado!: LiquidacionEstado;

  /** Medio (10/20/42/47) y fecha real del pago; obligatorios al aprobar. */
  @Prop({ type: { medio: String, fecha: String }, _id: false })
  pago?: { medio: string; fecha: string };

  @Prop({ trim: true })
  creadaPor?: string;

  @Prop({ trim: true })
  aprobadaPor?: string;

  @Prop()
  aprobadaEn?: Date;

  @Prop({ trim: true })
  anuladaPor?: string;

  @Prop()
  anuladaEn?: Date;
}

export const PayrollLiquidacionSchema = SchemaFactory.createForClass(PayrollLiquidacion);
// Una sola liquidación aprobada viva por empleado: la que reporta la nómina electrónica.
PayrollLiquidacionSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { estado: 'aprobada' }, name: 'liquidacion_aprobada_por_empleado' },
);
