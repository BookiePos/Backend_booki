import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  EXPENSE_STATUSES,
  ExpenseStatus,
  PAYMENT_METHODS,
  FinancePaymentMethod,
  RECURRENCE_FREQUENCIES,
  RecurrenceFrequency,
} from '../../domain/finance.constants';

export type FinanceRecurringExpenseDocument =
  HydratedDocument<FinanceRecurringExpense>;

/**
 * Plantilla de gasto recurrente (arriendo, servicios, suscripciones…). No es un
 * gasto: es la definición que, cada período, genera un `finance_expenses` real.
 * La generación es idempotente por `lastGeneratedDate` + guarda por
 * `recurringTemplateId`/`recurringPeriod` en el gasto creado. Montos COP entero.
 */
@Schema({ timestamps: true, collection: 'finance_recurring_expenses' })
export class FinanceRecurringExpense {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'FinanceCategory', required: true })
  categoryId!: Types.ObjectId;

  /** Snapshot del nombre de la categoría (se refresca al generar). */
  @Prop({ required: true, trim: true })
  categoryName!: string;

  @Prop({ required: true, trim: true })
  concept!: string;

  @Prop({ required: true, min: 0 })
  amount!: number;

  /** IVA descontable a copiar en cada gasto generado. */
  @Prop({ default: 0, min: 0 })
  taxAmount!: number;

  @Prop({ required: true, enum: RECURRENCE_FREQUENCIES, default: 'monthly' })
  frequency!: RecurrenceFrequency;

  /**
   * Día del mes de la ocurrencia (1–28) para frecuencias mensual/trimestral/
   * anual. Se limita a 28 para no depender de la longitud del mes. Ignorado en
   * la frecuencia semanal (que se ancla al día de `startDate`).
   */
  @Prop({ min: 1, max: 28, default: 1 })
  dayOfMonth!: number;

  /** Primera fecha de vigencia YYYY-MM-DD (ancla de las ocurrencias). */
  @Prop({ required: true, trim: true })
  startDate!: string;

  /** Fin de vigencia YYYY-MM-DD (opcional; null = sin fin). */
  @Prop({ type: String, default: null })
  endDate?: string | null;

  /** Estado del gasto a generar: pagado o por pagar. */
  @Prop({ required: true, enum: EXPENSE_STATUSES, default: 'payable' })
  defaultStatus!: ExpenseStatus;

  @Prop({ enum: PAYMENT_METHODS })
  paymentMethod?: FinancePaymentMethod;

  @Prop({ type: Types.ObjectId, ref: 'Supplier' })
  supplierId?: Types.ObjectId;

  @Prop({ trim: true })
  supplierName?: string;

  @Prop({ trim: true })
  note?: string;

  /** Plantilla en curso; si `false`, no genera (pausada). */
  @Prop({ default: true })
  active!: boolean;

  /** Si el job programado la genera sola; si `false`, solo generación manual. */
  @Prop({ default: true })
  autoGenerate!: boolean;

  /** Fecha de la última ocurrencia generada YYYY-MM-DD (null = ninguna). */
  @Prop({ type: String, default: null })
  lastGeneratedDate?: string | null;

  @Prop({ required: true, trim: true })
  createdByEmail!: string;
}

export const FinanceRecurringExpenseSchema = SchemaFactory.createForClass(
  FinanceRecurringExpense,
);

FinanceRecurringExpenseSchema.index({ sedeId: 1, active: 1 });
FinanceRecurringExpenseSchema.index({ active: 1, autoGenerate: 1 });
