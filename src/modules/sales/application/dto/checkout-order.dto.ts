import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
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

  @IsOptional()
  @ValidateNested()
  @Type(() => SaleCustomerDto)
  customer?: SaleCustomerDto;
}
