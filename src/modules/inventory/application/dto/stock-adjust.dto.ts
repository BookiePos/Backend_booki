import {
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { ADJUST_REASONS, AdjustReason } from '../../domain/inventory.constants';

/** Ajuste manual de stock (+/-) con razón. */
export class StockAdjustDto {
  @IsMongoId()
  productId!: string;

  @IsMongoId()
  sedeId!: string;

  @IsIn(['add', 'remove'])
  direction!: 'add' | 'remove';

  @IsNumber()
  @IsPositive()
  qty!: number;

  @IsIn(ADJUST_REASONS as readonly string[])
  reason!: AdjustReason;

  /** Lote específico a descontar; si no llega, se consume FEFO. */
  @IsOptional()
  @IsMongoId()
  lotId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
