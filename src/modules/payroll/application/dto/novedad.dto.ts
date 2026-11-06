import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { TIPOS_NOVEDAD } from '../../domain/novedades-calc';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Registra una novedad de ausencia (vacaciones, incapacidad o licencia). */
export class CrearNovedadDto {
  @IsMongoId()
  employeeId!: string;

  @IsIn(TIPOS_NOVEDAD as readonly string[])
  tipo!: string;

  @Matches(YYYYMMDD, { message: 'fechaInicio debe ser YYYY-MM-DD' })
  fechaInicio!: string;

  @Matches(YYYYMMDD, { message: 'fechaFin debe ser YYYY-MM-DD' })
  fechaFin!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  diasPreviosProrroga?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  diasHabiles?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  observacion?: string;
}
