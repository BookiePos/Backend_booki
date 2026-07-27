import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  DISCOUNT_TYPES,
  DiscountType,
  PAYMENT_METHODS,
  PaymentMethod,
} from '../../domain/sales.constants';

export class SaleDiscountDto {
  @IsIn(DISCOUNT_TYPES as readonly string[])
  type!: DiscountType;

  /** Monto en pesos (amount) o porcentaje 0–100 (percent). */
  @IsNumber()
  @Min(0)
  value!: number;
}

export class SaleLineDto {
  @IsMongoId()
  productId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;

  /** Descuento predefinido (de la sede) aplicado a esta línea. Opcional. */
  @IsOptional()
  @IsMongoId()
  discountId?: string;
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

/** Datos del cliente para la factura (todos opcionales). */
export class SaleCustomerDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  idNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;
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

  /** Descuento opcional sobre el total (requiere pos.discount.authorize). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleDiscountDto)
  discount?: SaleDiscountDto;

  /** Datos del cliente para la factura (opcional). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleCustomerDto)
  customer?: SaleCustomerDto;
}
