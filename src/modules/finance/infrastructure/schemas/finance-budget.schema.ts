import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  BUDGET_SCENARIOS,
  BudgetScenario,
  BUDGET_STATUSES,
  BudgetStatus,
  CATEGORY_KINDS,
  CategoryKind,
} from '../../domain/finance.constants';

export type FinanceBudgetDocument = HydratedDocument<FinanceBudget>;

/** Línea de presupuesto: 12 montos (uno por mes) de una categoría. */
@Schema({ _id: false })
export class BudgetLine {
  @Prop({ type: Types.ObjectId, ref: 'FinanceCategory', required: true })
  categoryId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  categoryName!: string;

  @Prop({ required: true, enum: CATEGORY_KINDS })
  kind!: CategoryKind;

  /** 12 montos (enero..diciembre) en COP entero. */
  @Prop({ type: [Number], default: () => Array(12).fill(0) })
  monthly!: number[];
}
const BudgetLineSchema = SchemaFactory.createForClass(BudgetLine);

/**
 * Presupuesto anual de un año fiscal. `sedeId` null = consolidado. Un escenario
 * (base/optimista/pesimista) y un estado (draft/active).
 */
@Schema({ timestamps: true, collection: 'finance_budgets' })
export class FinanceBudget {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true })
  fiscalYear!: number;

  @Prop({ type: Types.ObjectId, ref: 'Sede', default: null })
  sedeId?: Types.ObjectId | null;

  @Prop({ required: true, enum: BUDGET_SCENARIOS, default: 'base' })
  scenario!: BudgetScenario;

  @Prop({ required: true, enum: BUDGET_STATUSES, default: 'draft' })
  status!: BudgetStatus;

  @Prop({ type: [BudgetLineSchema], default: [] })
  lines!: BudgetLine[];

  @Prop({ required: true, trim: true })
  createdByEmail!: string;
}

export const FinanceBudgetSchema =
  SchemaFactory.createForClass(FinanceBudget);

FinanceBudgetSchema.index({ fiscalYear: 1, sedeId: 1 });
