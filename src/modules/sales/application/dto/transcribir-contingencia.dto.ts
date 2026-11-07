import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, Matches, Max, ValidateNested } from 'class-validator';

/** El talonario de contingencia (Fase 9): número impreso, sin prefijo, y su fecha. */
export class TalonarioContingenciaDto {
  @IsInt()
  @IsPositive()
  @Max(Number.MAX_SAFE_INTEGER)
  numero!: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha del talonario va en formato AAAA-MM-DD' })
  fecha!: string;
}

/**
 * Transcripción de contingencia de una venta (Fase 9). Sin talonario, el
 * número sale del contador de contingencia de la sede (la venta sin conexión
 * no tiene papel numerado); con él, se usa el número impreso.
 */
export class TranscribirContingenciaDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TalonarioContingenciaDto)
  talonario?: TalonarioContingenciaDto;
}
