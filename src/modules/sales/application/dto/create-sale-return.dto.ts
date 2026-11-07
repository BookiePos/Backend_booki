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

  /**
   * Llave del cliente para reintentar sin duplicar (Fase 6B): la misma llave
   * en la misma venta devuelve la devolución ya registrada y su nota fiscal.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;

  /**
   * Cliente al que se le deja el saldo a favor (Fase 6D, deuda). Solo se
   * admite cuando la venta no tiene cliente; si la venta ya lo tiene, tiene que
   * ser el mismo (la nota crédito va al adquiriente de la factura original,
   * nunca a otro). Debe existir en la empresa.
   */
  @IsOptional()
  @IsMongoId()
  customerId?: string;
}
