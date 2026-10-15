import {
  IsIn,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  Matches,
  Min,
} from 'class-validator';
import { PayrollNovedades } from '../../domain/payroll-calc';

/**
 * Calcula un desprendible sin persistir (simulador). Si llega employeeId se
 * toman salario/ARL/tipo del expediente; si no, se usan los valores enviados.
 */
export class PreviewPayrollDto {
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
  @IsNumber()
  @Min(0)
  diasTrabajados?: number;

  @IsOptional()
  @IsIn(['I', 'II', 'III', 'IV', 'V'])
  arlRiskLevel?: string;

  @IsOptional()
  @IsObject()
  novedades?: PayrollNovedades;

  /** Período simulado (YYYY-MM): fija la jornada vigente y el divisor de la hora. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period debe ser YYYY-MM' })
  period?: string;
}
