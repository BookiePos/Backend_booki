import { IsMongoId, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class OpenCajaDto {
  @IsMongoId()
  sedeId!: string;

  /** Base de efectivo con la que se abre la caja. */
  @IsNumber()
  @Min(0)
  openingAmount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
