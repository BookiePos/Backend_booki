import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  EXPENSE_STATUSES,
  ExpenseStatus,
  PAYMENT_METHODS,
  FinancePaymentMethod,
  RECURRENCE_FREQUENCIES,
  RecurrenceFrequency,
} from '../../domain/finance.constants';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Crea una plantilla de gasto recurrente. */
export class CreateRecurringExpenseDto {
  @IsMongoId()
  sedeId!: string;

  @IsMongoId()
  categoryId!: string;

  @IsString()
  @MaxLength(200)
  concept!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxAmount?: number;

  @IsIn(RECURRENCE_FREQUENCIES as readonly string[])
  frequency!: RecurrenceFrequency;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  dayOfMonth?: number;

  @Matches(YYYYMMDD, { message: 'startDate debe ser YYYY-MM-DD' })
  startDate!: string;

  @IsOptional()
  @Matches(YYYYMMDD, { message: 'endDate debe ser YYYY-MM-DD' })
  endDate?: string;

  @IsOptional()
  @IsIn(EXPENSE_STATUSES as readonly string[])
  defaultStatus?: ExpenseStatus;

  @IsOptional()
  @IsIn(PAYMENT_METHODS as readonly string[])
  paymentMethod?: FinancePaymentMethod;

  @IsOptional()
  @IsMongoId()
  supplierId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  supplierName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  autoGenerate?: boolean;
}

/** Actualiza una plantilla de gasto recurrente (merge parcial). */
export class UpdateRecurringExpenseDto {
  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  concept?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxAmount?: number;

  @IsOptional()
  @IsIn(RECURRENCE_FREQUENCIES as readonly string[])
  frequency?: RecurrenceFrequency;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  dayOfMonth?: number;

  @IsOptional()
  @Matches(YYYYMMDD, { message: 'startDate debe ser YYYY-MM-DD' })
  startDate?: string;

  @IsOptional()
  @Matches(YYYYMMDD, { message: 'endDate debe ser YYYY-MM-DD' })
  endDate?: string | null;

  @IsOptional()
  @IsIn(EXPENSE_STATUSES as readonly string[])
  defaultStatus?: ExpenseStatus;

  @IsOptional()
  @IsIn(PAYMENT_METHODS as readonly string[])
  paymentMethod?: FinancePaymentMethod;

  @IsOptional()
  @IsMongoId()
  supplierId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  supplierName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  autoGenerate?: boolean;
}
