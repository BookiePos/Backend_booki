import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';

/** Resolución de numeración DIAN (factura electrónica). Todo opcional. */
export class ResolucionFeDto {
  @IsOptional()
  @IsString()
  numero?: string;

  @IsOptional()
  @IsDateString()
  fechaResolucion?: string;

  @IsOptional()
  @IsString()
  prefijo?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rangoDesde?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rangoHasta?: number;

  @IsOptional()
  @IsDateString()
  vigenciaDesde?: string;

  @IsOptional()
  @IsDateString()
  vigenciaHasta?: string;

  @IsOptional()
  @IsString()
  claveTecnica?: string;
}
