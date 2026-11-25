import { IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/**
 * Cambio de los valores de ley que la nómina lee de Parámetros (con vigencia).
 * Nada se sobrescribe: cada valor abre una vigencia nueva desde `vigenteDesde`.
 * Los recargos van en porcentaje (35 = 35 %) y solo pueden subir sobre la ley.
 */
export class ActualizarValoresLeyDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'vigenteDesde debe ser YYYY-MM-DD' })
  vigenteDesde!: string;

  @IsOptional() @IsInt() @Min(100_000) @Max(100_000_000) smmlv?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) auxilioTransporte?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(500) recargoNocturno?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(500) extraDiurna?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(500) extraNocturna?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(500) recargoDominical?: number;

  /** Por qué se cambia (decreto, pacto con los trabajadores…). Queda en la vigencia. */
  @IsOptional() @IsString() @MaxLength(200) motivo?: string;
}
