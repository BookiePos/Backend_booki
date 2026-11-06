import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CONCEPTOS_REBAJA,
  REBATE_METHODS,
  type ConceptoRebaja,
  type RebateMethod,
} from '../../domain/sale-rebate';

/** Lo que se rebaja de un producto de la venta, con impuesto. */
export class SaleRebateLineDto {
  @IsMongoId()
  productId!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;
}

/**
 * Rebaja o descuento posterior sobre una venta ya cobrada (Fase 6C). Lleva el
 * monto total (se reparte por lo que queda de cada producto) o el monto por
 * producto, nunca los dos.
 */
export class CreateSaleRebateDto {
  /** 3 rebaja, 4 ajuste de precio, 5 pronto pago, 6 volumen (5 y 6 solo FEV). */
  @IsIn(CONCEPTOS_REBAJA as readonly string[])
  concepto!: ConceptoRebaja;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SaleRebateLineDto)
  lines?: SaleRebateLineDto[];

  /** Cómo se le reconoce: efectivo, transferencia o saldo a favor (2805). */
  @IsIn(REBATE_METHODS as readonly string[])
  refundMethod!: RebateMethod;

  /** Motivo en llano: va a la descripción de la nota. */
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;

  /** Llave del cliente: el reintento con la misma llave no rebaja dos veces. */
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey!: string;
}

/**
 * Nota crédito SIN referencia (CustomizationID 22, Fase 6C): el descuento por
 * volumen o pronto pago que cubre varias facturas del mismo cliente en un
 * periodo de máximo 30 días dentro de un mismo mes. Solo FEV.
 */
export class CreateNotaSinReferenciaDto {
  @IsMongoId()
  sedeId!: string;

  /** Cliente registrado al que se le facturó con FEV en el periodo. */
  @IsMongoId()
  customerId!: string;

  /** 3 rebaja, 4 ajuste de precio, 5 pronto pago, 6 volumen (nunca 2: CBF03a). */
  @IsIn(CONCEPTOS_REBAJA as readonly string[])
  concepto!: ConceptoRebaja;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'desde debe ser AAAA-MM-DD' })
  desde!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'hasta debe ser AAAA-MM-DD' })
  hasta!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsIn(REBATE_METHODS as readonly string[])
  refundMethod!: RebateMethod;

  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey!: string;
}
