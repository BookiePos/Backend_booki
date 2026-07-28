import {
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  Matches,
  Min,
} from 'class-validator';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Calcula la liquidación definitiva de un empleado (o datos manuales). */
export class LiquidacionDto {
  @IsOptional()
  @IsMongoId()
  employeeId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salarioBase?: number;

  @IsOptional()
  @IsIn(['ordinario', 'integral'])
  salaryType?: string;

  @IsOptional()
  @Matches(YYYYMMDD, { message: 'fechaInicio debe ser YYYY-MM-DD' })
  fechaInicio?: string;

  @Matches(YYYYMMDD, { message: 'fechaFin debe ser YYYY-MM-DD' })
  fechaFin!: string;

  @IsOptional()
  @IsIn(['indefinido', 'fijo', 'obra_labor', 'aprendizaje', 'prestacion_servicios'])
  contractType?: string;

  @IsIn(['renuncia', 'justa_causa', 'sin_justa_causa', 'fin_contrato', 'mutuo_acuerdo'])
  motivo!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salariosPendientes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  diasFaltantesContrato?: number;
}
