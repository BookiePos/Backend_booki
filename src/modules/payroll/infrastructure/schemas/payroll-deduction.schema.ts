import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PayrollDeductionDocument = HydratedDocument<PayrollDeduction>;

export const DEDUCTION_STATUSES = [
  'pending', // creado (p.ej. consumo POS), a la espera de aprobación
  'approved', // aprobado; entrará en la próxima corrida
  'applied', // ya descontado en una corrida
  'rejected', // rechazado, no se descuenta
  'cancelled', // anulado antes de aplicar
] as const;
export type DeductionStatus = (typeof DEDUCTION_STATUSES)[number];

export const DEDUCTION_SOURCES = ['sale', 'manual'] as const;
export type DeductionSource = (typeof DEDUCTION_SOURCES)[number];

/**
 * Deducción a la nómina de un empleado (p.ej. un consumo/fiado del propio
 * empleado). Requiere aprobación; al aprobarse, la próxima corrida la toma como
 * "otras deducciones", la resta del neto y la lista en la colilla.
 */
@Schema({ timestamps: true, collection: 'payroll_deductions' })
export class PayrollDeduction {
  @Prop({ required: true, index: true })
  employeeId!: string;

  @Prop({ required: true, trim: true })
  employeeName!: string;

  @Prop({ trim: true })
  docNumber?: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  concept!: string;

  @Prop({ required: true, min: 0 })
  amount!: number;

  /** Fecha del consumo/deducción (YYYY-MM-DD). */
  @Prop({ required: true, trim: true })
  date!: string;

  @Prop({
    required: true,
    enum: DEDUCTION_STATUSES,
    default: 'pending',
    index: true,
  })
  status!: DeductionStatus;

  @Prop({ enum: DEDUCTION_SOURCES, default: 'manual' })
  source!: DeductionSource;

  /** Origen (venta a crédito de empleado, etc.). */
  @Prop({ trim: true })
  sourceId?: string;

  @Prop({ trim: true })
  note?: string;

  @Prop({ trim: true })
  createdByEmail?: string;

  @Prop({ trim: true })
  approvedByEmail?: string;

  /** Corrida en la que se aplicó (si status = applied). */
  @Prop({ type: Types.ObjectId, ref: 'PayrollRun' })
  appliedRunId?: Types.ObjectId;

  @Prop({ trim: true })
  appliedPeriod?: string;
}

export const PayrollDeductionSchema =
  SchemaFactory.createForClass(PayrollDeduction);

PayrollDeductionSchema.index({ employeeId: 1, status: 1 });
PayrollDeductionSchema.index({ status: 1, date: -1 });
