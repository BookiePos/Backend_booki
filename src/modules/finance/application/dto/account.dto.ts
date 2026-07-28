import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
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

  /** Marca el movimiento como conciliado al crearlo (flujo de conciliación). */
  @IsOptional()
  @IsBoolean()
  reconciled?: boolean;
}

/**
 * Finaliza la conciliación de una cuenta contra un extracto: marca el conjunto
 * de movimientos conciliados (autoritativo: los demás quedan no conciliados),
 * crea los movimientos del extracto que faltaban (p.ej. comisión de datáfono) y
 * guarda el saldo/fecha del extracto en la cuenta.
 */
export class ReconcileAccountDto {
  @Matches(YYYYMMDD, { message: 'statementDate debe ser YYYY-MM-DD' })
  statementDate!: string;

  @IsNumber()
  statementBalance!: number;

  /** Movimientos existentes que quedan conciliados. */
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  reconciledMovementIds?: string[];

  /** Movimientos del extracto que no estaban en la app (se crean conciliados). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateMovementDto)
  newMovements?: CreateMovementDto[];
}
