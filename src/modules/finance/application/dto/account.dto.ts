import {
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ACCOUNT_TYPES,
  AccountType,
  MOVEMENT_DIRECTIONS,
  MovementDirection,
} from '../../domain/finance.constants';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Crea una cuenta de tesorería. `sedeId` opcional (null = consolidada). */
export class CreateAccountDto {
  @IsOptional()
  @IsMongoId()
  sedeId?: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(ACCOUNT_TYPES as readonly string[])
  type!: AccountType;

  @IsOptional()
  @IsNumber()
  openingBalance?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Registra un movimiento de una cuenta. */
export class CreateMovementDto {
  @Matches(YYYYMMDD, { message: 'date debe ser YYYY-MM-DD' })
  date!: string;

  @IsIn(MOVEMENT_DIRECTIONS as readonly string[])
  direction!: MovementDirection;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @IsString()
  @MaxLength(200)
  concept!: string;
}
