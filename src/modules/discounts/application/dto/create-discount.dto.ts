import {
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { DISCOUNT_TYPES, DiscountKind } from '../../domain/discount.constants';

export class CreateDiscountDto {
  @IsMongoId()
  sedeId!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(DISCOUNT_TYPES as readonly string[])
  type!: DiscountKind;

  /** Porcentaje 0–100 (percent) o monto en pesos (amount). */
  @IsNumber()
  @Min(0)
  value!: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
