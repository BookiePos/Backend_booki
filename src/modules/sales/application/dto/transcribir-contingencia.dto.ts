import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsPositive, Matches, Max, ValidateNested } from 'class-validator';

/** El talonario de contingencia (Fase 9): número impreso, sin prefijo, y su fecha. */
export class TalonarioContingenciaDto {
  @IsInt()
  @IsPositive()
  @Max(Number.MAX_SAFE_INTEGER)
  numero!: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha del talonario va en formato AAAA-MM-DD' })
  fecha!: string;

  /** Hora del papel (HH:MM o HH:MM:SS, Colombia). Sin ella, la de la venta. */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, { message: 'La hora del talonario va en formato HH:MM o HH:MM:SS' })
  hora?: string;
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

  /**
   * Cuándo se superó la falla (ISO 8601): desde ahí corren las 48 h. Por
   * defecto, ahora (talonario) o cuando la venta llegó (sin conexión). El
   * servicio rechaza una fecha futura o anterior a la venta.
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  superadaAt?: string;
}
