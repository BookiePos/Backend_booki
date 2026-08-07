import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Una fila del CSV de carga de existencias. Cada fila es una ENTRADA de
 * mercancía (suma stock): se resuelve el producto por `sku` y la sede por
 * nombre o código. `sku`, `sede` y `qty` son obligatorios de negocio pero se
 * dejan opcionales aquí para validar por fila en el service sin tumbar el lote.
 */
export class ImportStockRow {
  @IsOptional()
  @IsString()
  sku?: string;

  /** Nombre o código de la sede. */
  @IsOptional()
  @IsString()
  sede?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  qty?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsString()
  lotCode?: string;

  /** Vencimiento (obligatorio si el producto es perecedero). YYYY-MM-DD. */
  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  supplier?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ImportStockDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => ImportStockRow)
  rows!: ImportStockRow[];
}

/** Resumen del resultado de una carga de existencias. */
export interface ImportStockResult {
  total: number;
  imported: number;
  errors: { row: number; sku: string; sede: string; message: string }[];
}
