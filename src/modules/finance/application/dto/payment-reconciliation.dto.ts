import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CARD_FRANCHISES,
} from '../../../sales/domain/sales.constants';
import { RECON_CHANNELS, ReconChannel } from '../../domain/payment-reconciliation';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Pesos enteros: el extracto no lleva centavos (cop()). */
export class SettlementItemDto {
  @Matches(YYYYMMDD, { message: 'date debe ser YYYY-MM-DD' })
  date!: string;

  @IsIn(RECON_CHANNELS as readonly string[])
  channel!: ReconChannel;

  @IsOptional()
  @IsIn(CARD_FRANCHISES as readonly string[])
  franchise?: string;

  @IsInt()
  @Min(0)
  statementAmount!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  commission?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  commissionIva?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  retefuente?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  reteIca?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  reteIva?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class CreateSettlementsDto {
  @IsMongoId()
  sedeId!: string;

  @IsIn(['manual', 'csv'])
  source!: 'manual' | 'csv';

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SettlementItemDto)
  items!: SettlementItemDto[];
}

export class ImportStatementDto {
  @IsMongoId()
  sedeId!: string;

  /** Contenido del CSV del extracto (texto). */
  @IsString()
  @MaxLength(500_000)
  csv!: string;

  /** Canal por omisión cuando el CSV no trae la columna. */
  @IsOptional()
  @IsIn(RECON_CHANNELS as readonly string[])
  channel?: ReconChannel;
}
