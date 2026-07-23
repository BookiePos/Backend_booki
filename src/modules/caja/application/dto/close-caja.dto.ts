import { IsMongoId, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CloseCajaDto {
  @IsMongoId()
  sedeId!: string;

  /** Efectivo contado físicamente en la caja al cerrar. */
  @IsNumber()
  @Min(0)
  countedAmount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
