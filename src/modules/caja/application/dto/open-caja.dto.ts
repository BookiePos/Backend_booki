import { IsMongoId, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class OpenCajaDto {
  @IsMongoId()
  sedeId!: string;

  /** Base de efectivo con la que se abre la caja (billetes + monedas). */
  @IsNumber()
  @Min(0)
  openingAmount!: number;

  /** Desglose de la base: efectivo en billetes. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  openingBills?: number;

  /** Desglose de la base: efectivo en monedas. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  openingCoins?: number;

  @IsOptional()
  @IsString()
  note?: string;
}
