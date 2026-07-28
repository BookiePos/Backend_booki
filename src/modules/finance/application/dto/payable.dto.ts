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
  PAYMENT_METHODS,
  FinancePaymentMethod,
} from '../../domain/finance.constants';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Crea una cuenta por pagar a un proveedor. */
export class CreatePayableDto {
  @IsMongoId()
  sedeId!: string;

  @IsOptional()
  @IsMongoId()
  supplierId?: string;

  @IsString()
  @MaxLength(200)
  supplierName!: string;

  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  docNumber?: string;

  @Matches(YYYYMMDD, { message: 'issueDate debe ser YYYY-MM-DD' })
  issueDate!: string;

  @Matches(YYYYMMDD, { message: 'dueDate debe ser YYYY-MM-DD' })
  dueDate!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Registra un abono a una cuenta por pagar. */
export class CreatePayablePaymentDto {
  @Matches(YYYYMMDD, { message: 'date debe ser YYYY-MM-DD' })
  date!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsIn(PAYMENT_METHODS as readonly string[])
  method?: FinancePaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
