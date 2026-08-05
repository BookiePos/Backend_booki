import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  EXPENSE_STATUSES,
  ExpenseStatus,
  PAYMENT_METHODS,
  FinancePaymentMethod,
} from '../../domain/finance.constants';

export type FinanceExpenseDocument = HydratedDocument<FinanceExpense>;

/**
 * Gasto de una sede. Si `status = 'paid'` ya salió el dinero; si 'payable' es
 * una obligación pendiente. Monto en COP entero; `taxAmount` es el IVA
 * descontable de la compra.
 */
@Schema({ timestamps: true, collection: 'finance_expenses' })
export class FinanceExpense {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'FinanceCategory', required: true })
  categoryId!: Types.ObjectId;

  /** Snapshot del nombre de la categoría al momento del gasto. */
  @Prop({ required: true, trim: true })
  categoryName!: string;

  @Prop({ required: true, trim: true })
  concept!: string;

  @Prop({ required: true, min: 0 })
  amount!: number;

  /** IVA descontable de la compra (0 si no aplica). */
  @Prop({ default: 0, min: 0 })
  taxAmount!: number;

  /** Fecha del gasto en formato YYYY-MM-DD (string, no Date). */
  @Prop({ required: true, trim: true })
  date!: string;

  @Prop({ required: true, enum: EXPENSE_STATUSES, default: 'paid' })
  status!: ExpenseStatus;

  @Prop({ enum: PAYMENT_METHODS })
  paymentMethod?: FinancePaymentMethod;

  @Prop({ type: Types.ObjectId, ref: 'Supplier' })
  supplierId?: Types.ObjectId;

  @Prop({ trim: true })
  supplierName?: string;

  @Prop({ default: false })
  recurring!: boolean;

  /** Plantilla recurrente que lo generó (si nació de una). */
  @Prop({ type: Types.ObjectId, ref: 'FinanceRecurringExpense', default: null })
  recurringTemplateId?: Types.ObjectId | null;

  /** Fecha-ocurrencia YYYY-MM-DD que cubre este gasto (guarda anti-duplicado). */
  @Prop({ type: String, default: null })
  recurringPeriod?: string | null;

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, trim: true })
  createdByEmail!: string;
}

export const FinanceExpenseSchema =
  SchemaFactory.createForClass(FinanceExpense);

FinanceExpenseSchema.index({ sedeId: 1, date: -1 });
FinanceExpenseSchema.index({ categoryId: 1, date: -1 });
FinanceExpenseSchema.index({ status: 1 });
// Anti-duplicado de la generación recurrente: 1 gasto por plantilla+ocurrencia.
FinanceExpenseSchema.index(
  { recurringTemplateId: 1, recurringPeriod: 1 },
  {
    unique: true,
    partialFilterExpression: { recurringTemplateId: { $type: 'objectId' } },
  },
);
