import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';
import { LOTE_EMISION_MAX } from '../nomina-periodo.service';

export class EmitirPeriodoNominaDto {
  /** Último empleadoId procesado (`siguienteCursor` de la llamada anterior). */
  @IsOptional()
  @IsMongoId()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LOTE_EMISION_MAX)
  limite?: number;
}
