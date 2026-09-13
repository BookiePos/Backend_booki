import { Type } from 'class-transformer';
import {
  IsArray,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  SaleCustomerDto,
  SaleDiscountDto,
  SalePackagingDto,
  SalePaymentDto,
  SaleSellerDto,
} from './create-sale.dto';

/** Una parte de la cuenta que alguien paga ahora. */
export class CheckoutLineDto {
  @IsMongoId()
  productId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;
}

/** Liquidación de una cuenta abierta: pago, descuento y cliente (factura). */
export class CheckoutOrderDto {
  @ValidateNested()
  @Type(() => SalePaymentDto)
  payment!: SalePaymentDto;

  /**
   * Subconjunto que se cobra ahora, para dividir la cuenta de una mesa.
   *
   * SIN este campo se cobra todo lo que falte, que es el cobro de siempre —la
   * comanda que se paga entera— y también el último de una cuenta dividida.
   * Mandar el último sin líneas es lo que hace que lo que no se pudo repartir
   * exacto lo absorba quien paga de último, en vez de quedar colgando.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  lines?: CheckoutLineDto[];

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

  /** Empaque gastado al liquidar la cuenta (bolsas para llevar, servilletas). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalePackagingDto)
  packaging?: SalePackagingDto[];

  /** Quién vendió. Sin este campo, el vendedor es quien cobra. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleSellerDto)
  seller?: SaleSellerDto;
}
