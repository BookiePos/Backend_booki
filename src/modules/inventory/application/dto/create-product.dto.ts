import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { ITEM_TYPES, ItemType } from '../../domain/inventory.constants';

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsOptional()
  @IsIn(ITEM_TYPES as readonly string[])
  itemType?: ItemType;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
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
  @IsDateString()
  expiresAt?: string;

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
}
