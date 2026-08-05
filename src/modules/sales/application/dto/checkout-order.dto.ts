import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Min, ValidateNested } from 'class-validator';
import {
  SaleCustomerDto,
  SaleDiscountDto,
  SalePaymentDto,
} from './create-sale.dto';

/** Liquidación de una cuenta abierta: pago, descuento y cliente (factura). */
export class CheckoutOrderDto {
  @ValidateNested()
  @Type(() => SalePaymentDto)
  payment!: SalePaymentDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SaleDiscountDto)
  discount?: SaleDiscountDto;

  /** Propina voluntaria (restaurante): se cobra encima del total. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  tip?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => SaleCustomerDto)
  customer?: SaleCustomerDto;
}
