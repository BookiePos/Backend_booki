import {
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

/** Entrada de mercancía (recepción de compra o carga inicial). */
export class StockEntryDto {
  @IsMongoId()
  productId!: string;

  @IsMongoId()
  sedeId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;

  @IsOptional()
  @IsNumber()
  unitCost?: number;

  /** Código de lote; si el producto controla lotes y no llega, se genera. */
  @IsOptional()
  @IsString()
  lotCode?: string;

  /** Fecha de vencimiento (obligatoria si el producto es perecedero). */
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
