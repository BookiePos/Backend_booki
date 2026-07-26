import { IsMongoId, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CloseCajaDto {
  @IsMongoId()
  sedeId!: string;

  /** Efectivo contado físicamente en la caja al cerrar (billetes + monedas). */
  @IsNumber()
  @Min(0)
  countedAmount!: number;

  /** Desglose del efectivo contado: billetes. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  countedBills?: number;

  /** Desglose del efectivo contado: monedas. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  countedCoins?: number;

  @IsOptional()
  @IsString()
  note?: string;
}
