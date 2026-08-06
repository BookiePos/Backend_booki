import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ITEM_TYPES, ItemType } from '../../domain/inventory.constants';

/**
 * Una fila del CSV de importación de productos. `sku` y `name` son obligatorios
 * de negocio pero se dejan OPCIONALES aquí para que una fila incompleta no
 * tumbe todo el lote en el ValidationPipe: la presencia se valida por fila en el
 * service y se reporta como error individual. `category` es el NOMBRE de la
 * categoría (se resuelve o se crea al importar).
 */
export class ImportProductRow {
  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(ITEM_TYPES as readonly string[])
  itemType?: ItemType;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  supplier?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;

  @IsOptional()
  @IsBoolean()
  perishable?: boolean;

  @IsOptional()
  @IsBoolean()
  trackLots?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  shelfLifeDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minStock?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salePrice?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ImportProductsDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => ImportProductRow)
  rows!: ImportProductRow[];
}

/** Resumen del resultado de una importación (creados/actualizados/errores). */
export interface ImportProductsResult {
  total: number;
  created: number;
  updated: number;
  errors: { row: number; sku: string; message: string }[];
}
