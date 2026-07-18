import {
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

/** Traslado de stock entre sedes (conserva lotes y vencimientos). */
export class StockTransferDto {
  @IsMongoId()
  productId!: string;

  @IsMongoId()
  fromSedeId!: string;

  @IsMongoId()
  toSedeId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
