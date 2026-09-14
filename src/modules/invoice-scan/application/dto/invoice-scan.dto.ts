import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LINE_TARGETS, LineTarget } from '../../domain/invoice-scan.constants';

/** Cómo se emparejó un renglón; mismos valores que `LineDecision.matchedBy`. */
export const MATCHED_BY = ['alias', 'barcode', 'sku', 'name', 'manual', 'none'] as const;
export type MatchedBy = (typeof MATCHED_BY)[number];

/** Datos con los que crear un producto que no existe en el inventario. */
export class NewProductDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salePrice?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  barcode?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minStock?: number;
}

/** Qué hacer con un renglón al aplicar la factura. */
export class LineDecisionDto {
  @IsInt()
  @Min(0)
  lineIndex!: number;

  @IsIn(LINE_TARGETS as readonly string[])
  target!: LineTarget;

  @IsOptional()
  @IsMongoId()
  productId?: string;

  @IsOptional()
  @IsBoolean()
  createProduct?: boolean;

  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  /**
   * La cantidad de la factura viene en la presentación de compra del producto
   * ("3 BULTOS"), no en la unidad de consumo. Se propone solo cuando el
   * producto emparejado tiene presentación definida, y la persona lo confirma.
   */
  @IsOptional()
  @IsBoolean()
  inPurchaseUnits?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => NewProductDto)
  newProduct?: NewProductDto;

  /**
   * Cómo se emparejó la línea. La API lo devuelve en cada decisión y la
   * pantalla de revisión reenvía las decisiones tal cual al guardar: sin
   * declararlo aquí, `forbidNonWhitelisted` rechazaba con 400 el guardado —y
   * con él el botón "Aplicar", que guarda antes de aplicar—.
   */
  @IsOptional()
  @IsIn(MATCHED_BY as readonly string[])
  matchedBy?: MatchedBy;
}

export class UpdateInvoiceScanDto {
  /**
   * Borrador completo corregido por la persona.
   *
   * Va como objeto libre y no como DTO anidado a propósito: lo que el modelo
   * leyó puede traer campos parciales o inesperados, y el parser defensivo del
   * dominio ya sabe normalizarlo. Validarlo aquí campo a campo solo lograría
   * rechazar correcciones legítimas a medio escribir.
   */
  @IsOptional()
  @IsObject()
  draft?: Record<string, unknown>;

  /** Proveedor elegido a mano (o vacío para quitar el emparejamiento). */
  @IsOptional()
  supplierId?: string | null;

  /** Sede a la que entra la mercancía. */
  @IsOptional()
  sedeId?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineDecisionDto)
  lineDecisions?: LineDecisionDto[];
}

export class MergeInvoiceScanDto {
  /** Factura que se absorbe como página adicional de esta. */
  @IsMongoId()
  sourceId!: string;
}

export class SplitInvoiceScanDto {
  @IsInt()
  @Min(0)
  pageIndex!: number;
}
