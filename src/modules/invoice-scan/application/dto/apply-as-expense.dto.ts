import {
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
} from '../../../finance/domain/finance.constants';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Datos para registrar la factura ENTERA como un gasto.
 *
 * Los importes van separados —base, IVA, retenciones— y no como un total
 * suelto porque cada uno va a una cuenta distinta: el IVA es descontable y lo
 * retenido se le debe a la DIAN, no al proveedor.
 */
export class ApplyAsExpenseDto {
  @IsMongoId()
  sedeId!: string;

  @IsMongoId()
  categoryId!: string;

  @IsString()
  @MaxLength(200)
  concept!: string;

  @Matches(YYYYMMDD, { message: 'date debe ser YYYY-MM-DD' })
  date!: string;

  /** Base gravable: el valor antes de IVA. */
  @IsNumber()
  @Min(0)
  amount!: number;

  /** IVA descontable de la factura. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  taxAmount?: number;

  /** Retenciones practicadas al proveedor (ReteFuente + ReteIVA + ReteICA). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  withholdingAmount?: number;

  /** `paid`: ya se pagó (de contado). `payable`: queda como cuenta por pagar. */
  @IsIn(EXPENSE_STATUSES as readonly string[])
  status!: ExpenseStatus;

  /** Obligatorio cuando `status = paid`: decide si sale de caja o de bancos. */
  @IsOptional()
  @IsIn(PAYMENT_METHODS as readonly string[])
  paymentMethod?: FinancePaymentMethod;

  /** Vencimiento de la cuenta por pagar. Sin él se usa el plazo del negocio. */
  @IsOptional()
  @Matches(YYYYMMDD, { message: 'dueDate debe ser YYYY-MM-DD' })
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  note?: string;
}
