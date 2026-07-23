import {
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import {
  CAJA_MOVEMENT_TYPES,
  CajaMovementType,
} from '../../domain/caja.constants';

export class CajaMovementDto {
  @IsMongoId()
  sedeId!: string;

  @IsIn(CAJA_MOVEMENT_TYPES as readonly string[])
  type!: CajaMovementType;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
