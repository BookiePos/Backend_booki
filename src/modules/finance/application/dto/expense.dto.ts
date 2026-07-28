import {
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import {
  EXPENSE_STATUSES,
  ExpenseStatus,
  PAYMENT_METHODS,
  FinancePaymentMethod,
} from '../../domain/finance.constants';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Registra un gasto de una sede. */
export class CreateExpenseDto {
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

  @Matches(YYYYMMDD, { message: 'date debe ser YYYY-MM-DD' })
  date!: string;

  @IsOptional()
  @IsIn(EXPENSE_STATUSES as readonly string[])
  status?: ExpenseStatus;

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
  @IsBoolean()
  recurring?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Actualiza un gasto (merge parcial). */
export class UpdateExpenseDto {
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
  @Matches(YYYYMMDD, { message: 'date debe ser YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsIn(EXPENSE_STATUSES as readonly string[])
  status?: ExpenseStatus;

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
  @IsBoolean()
  recurring?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
