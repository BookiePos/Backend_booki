import {
  IsBoolean,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_DELIVERY_FEE } from '../../domain/delivery.constants';

export class CreateDeliveryZoneDto {
  @IsMongoId()
  sedeId!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  /** Lo que se le cobra al cliente por llevarle el pedido a esa zona. */
  @IsNumber()
  @Min(0)
  @Max(MAX_DELIVERY_FEE)
  fee!: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateDeliveryZoneDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_DELIVERY_FEE)
  fee?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
