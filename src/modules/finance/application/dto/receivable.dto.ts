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

/**
 * Crea una cuenta por cobrar (fiado). Requiere un cliente REGISTRADO
 * (`customerId`); el nombre/documento/teléfono se toman del cliente.
 */
export class CreateReceivableDto {
  @IsMongoId()
  sedeId!: string;

  @IsMongoId()
  customerId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  docNumber?: string;

  @Matches(YYYYMMDD, { message: 'issueDate debe ser YYYY-MM-DD' })
  issueDate!: string;

  /** Vencimiento. Si se omite, se toma issueDate + `finanzas.dias_gracia_cxc`. */
  @IsOptional()
  @Matches(YYYYMMDD, { message: 'dueDate debe ser YYYY-MM-DD' })
  dueDate?: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Registra un abono a una cuenta por cobrar. */
export class CreateReceivablePaymentDto {
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
