import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CATALOG_SOURCE_TYPES,
  CatalogSourceType,
  IVA_RATES,
  IVA_TYPES,
  IvaRate,
  IvaType,
} from '../../domain/catalog.constants';
import { RecipeLineDto } from './recipe-line.dto';

export class UpdateCatalogProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sku?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Cadena vacía = quitar categoría. */
  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salePrice?: number;

  @IsOptional()
  @IsIn(IVA_RATES as readonly number[])
  ivaRate?: IvaRate;

  @IsOptional()
  @IsIn(IVA_TYPES as readonly string[])
  ivaType?: IvaType;

  @IsOptional()
  @IsIn(CATALOG_SOURCE_TYPES as readonly string[])
  sourceType?: CatalogSourceType;

  /** Cadena vacía = quitar vínculo con el ítem de inventario. */
  @IsOptional()
  @IsString()
  inventoryProductId?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  qtyPerUnit?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipeLineDto)
  recipe?: RecipeLineDto[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
