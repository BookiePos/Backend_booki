import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Un precio pactado dentro de una lista. */
export class PriceListItemDto {
  @IsMongoId()
  catalogProductId!: string;

  @IsNumber()
  @Min(0)
  price!: number;

  /** Desde cuántas unidades aplica. Sin valor, aplica siempre. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  minQty?: number;
}

export class CreatePriceListDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Descuento general sobre el precio de mostrador (0–100). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => PriceListItemDto)
  items?: PriceListItemDto[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdatePriceListDto extends CreatePriceListDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  declare name: string;
}
