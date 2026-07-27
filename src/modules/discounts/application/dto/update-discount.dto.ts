import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { DISCOUNT_TYPES, DiscountKind } from '../../domain/discount.constants';

export class UpdateDiscountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsIn(DISCOUNT_TYPES as readonly string[])
  type?: DiscountKind;

  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
