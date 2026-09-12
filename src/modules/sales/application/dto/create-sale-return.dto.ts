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
  ValidateNested,
} from 'class-validator';
import {
  REFUND_METHODS,
  RESTOCK_MODES,
  RETURN_REASONS,
  RefundMethod,
  RestockMode,
  ReturnReason,
} from '../../domain/sale-return';

/** Una línea que el cliente trae de vuelta. */
export class SaleReturnLineDto {
  /** Producto del catálogo, tal como aparece en la venta. */
  @IsMongoId()
  productId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;
}

export class CreateSaleReturnDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SaleReturnLineDto)
  lines!: SaleReturnLineDto[];

  @IsIn(RETURN_REASONS as readonly string[])
  reason!: ReturnReason;

  /**
   * Qué se hace con lo devuelto. No tiene valor por defecto a propósito: una
   * gaseosa sin abrir vuelve al estante y una torta manoseada no, y eso solo
   * lo sabe quien la está recibiendo.
   */
  @IsIn(RESTOCK_MODES as readonly string[])
  restock!: RestockMode;

  /** Cómo se le devuelve la plata. `none` = cambio por otro producto. */
  @IsIn(REFUND_METHODS as readonly string[])
  refundMethod!: RefundMethod;

  @IsOptional()
  @IsString()
  note?: string;
}
