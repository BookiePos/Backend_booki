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
  IVA_RATES,
  IVA_TYPES,
  IvaRate,
  IvaType,
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

  /** Tarifa de IVA (0/5/19); el precio ya la incluye. Default 19. */
  @IsOptional()
  @IsIn(IVA_RATES as readonly number[])
  ivaRate?: IvaRate;

  /** Tratamiento de IVA: gravado / exento / excluido. Default gravado. */
  @IsOptional()
  @IsIn(IVA_TYPES as readonly string[])
  ivaType?: IvaType;

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
