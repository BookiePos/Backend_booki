import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
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
} from '../../domain/catalog.constants';
import { RecipeLineDto } from './recipe-line.dto';

export class CreateCatalogProductDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @IsNumber()
  @Min(0)
  salePrice!: number;

  @IsIn(CATALOG_SOURCE_TYPES as readonly string[])
  sourceType!: CatalogSourceType;

  /** Fuente inventario: ítem vinculado. */
  @IsOptional()
  @IsMongoId()
  inventoryProductId?: string;

  /** Fuente inventario: consumo por unidad vendida. */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  qtyPerUnit?: number;

  /** Fuente receta: ingredientes con cantidades. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipeLineDto)
  recipe?: RecipeLineDto[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
