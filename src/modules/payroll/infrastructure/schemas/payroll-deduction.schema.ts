import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { INDICE_ARRASTRE_VIVO } from '../../domain/payroll-deduction.indices';

export type PayrollDeductionDocument = HydratedDocument<PayrollDeduction>;

export const DEDUCTION_STATUSES = [
  'pending', // creado (p.ej. consumo POS), a la espera de aprobación
  'approved', // aprobado; entrará en la próxima corrida
  'applied', // ya descontado en una corrida
  'rejected', // rechazado, no se descuenta
  'cancelled', // anulado antes de aplicar
] as const;
export type DeductionStatus = (typeof DEDUCTION_STATUSES)[number];

/**
 * - `sale`: fiado del POS (cancela la 1305 que abrió la venta).
 * - `manual`: libranzas, embargos, préstamos de terceros (2370).
 * - `arrastre`: saldo a cargo del empleado que dejó una colilla con neto
 *   negativo; lo crea el cierre de la corrida de origen (`sourceId` = id de
 *   esa corrida) y cancela la 1365 en la nómina siguiente. No se crea a mano.
 */
export const DEDUCTION_SOURCES = ['sale', 'manual', 'arrastre'] as const;
export type DeductionSource = (typeof DEDUCTION_SOURCES)[number];
/** Orígenes que se pueden crear por la API (el arrastre lo crea el cierre). */
export const DEDUCTION_SOURCES_API = ['sale', 'manual'] as const;

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

  /**
   * Corrida de origen de un arrastre anulado. Al anularlo, `sourceId` se mueve
   * aquí para que deje de ocupar el índice único y un nuevo cierre pueda crear
   * el arrastre vigente.
   */
  @Prop({ trim: true })
  sourceIdAnulado?: string;

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
PayrollDeductionSchema.index(INDICE_ARRASTRE_VIVO.keys, INDICE_ARRASTRE_VIVO.options);
