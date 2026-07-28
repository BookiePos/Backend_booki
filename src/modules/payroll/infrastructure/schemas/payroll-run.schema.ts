import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';
import { PayrollBreakdown } from '../../domain/payroll-calc';

export type PayrollRunDocument = HydratedDocument<PayrollRun>;

/** Desprendible de un empleado dentro de una corrida de nómina. */
@Schema({ _id: false })
export class PayrollSlip {
  @Prop({ required: true })
  employeeId!: string;

  @Prop({ required: true, trim: true })
  employeeName!: string;

  @Prop({ trim: true })
  docNumber?: string;

  @Prop({ trim: true })
  positionName?: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  @Prop({ required: true })
  salarioBase!: number;

  @Prop({ required: true })
  salaryType!: string;

  @Prop({ trim: true })
  arlRiskLevel?: string;

  @Prop({ required: true })
  diasTrabajados!: number;

  /** Desglose completo del cálculo (devengados, deducciones, aportes…). */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  breakdown!: PayrollBreakdown;

  @Prop({ required: true })
  totalDevengado!: number;

  @Prop({ required: true })
  totalDeducciones!: number;

  @Prop({ required: true })
  netoPagar!: number;

  @Prop({ required: true })
  costoEmpleador!: number;
}
const PayrollSlipSchema = SchemaFactory.createForClass(PayrollSlip);

/** Totales de la corrida. */
@Schema({ _id: false })
export class PayrollTotals {
  @Prop({ default: 0 })
  devengado!: number;

  @Prop({ default: 0 })
  deducciones!: number;

  @Prop({ default: 0 })
  neto!: number;

  @Prop({ default: 0 })
  aportes!: number;

  @Prop({ default: 0 })
  provisiones!: number;

  @Prop({ default: 0 })
  costo!: number;
}
const PayrollTotalsSchema = SchemaFactory.createForClass(PayrollTotals);

/**
 * Corrida de nómina de un período (mes) sobre un conjunto de empleados. Guarda
 * cada desprendible calculado y los totales, como comprobante del período.
 */
@Schema({ timestamps: true, collection: 'payroll_runs' })
export class PayrollRun {
  /** Período YYYY-MM. */
  @Prop({ required: true, trim: true, index: true })
  period!: string;

  @Prop({ trim: true })
  label?: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  /** 'sede' | 'all' */
  @Prop({ required: true, default: 'all' })
  coverage!: string;

  /** 'borrador' | 'cerrada' */
  @Prop({ required: true, default: 'borrador' })
  status!: string;

  @Prop({ type: [PayrollSlipSchema], default: [] })
  slips!: PayrollSlip[];

  @Prop({ type: PayrollTotalsSchema, default: {} })
  totals!: PayrollTotals;

  @Prop({ trim: true })
  createdByEmail?: string;
}

export const PayrollRunSchema = SchemaFactory.createForClass(PayrollRun);
PayrollRunSchema.index({ period: 1, createdAt: -1 });
