import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  Min,
  ValidateNested,
} from 'class-validator';
import { PAYMENT_METHODS, PaymentMethod } from '../../domain/sales.constants';

export class SaleLineDto {
  @IsMongoId()
  productId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;
}

export class SalePaymentDto {
  @IsIn(PAYMENT_METHODS as readonly string[])
  method!: PaymentMethod;

  /** Monto recibido en efectivo (para calcular el cambio). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  received?: number;
}

/** El precio NUNCA viene del cliente: se toma el salePrice del servidor. */
export class CreateSaleDto {
  @IsMongoId()
  sedeId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines!: SaleLineDto[];

  @ValidateNested()
  @Type(() => SalePaymentDto)
  payment!: SalePaymentDto;
}
