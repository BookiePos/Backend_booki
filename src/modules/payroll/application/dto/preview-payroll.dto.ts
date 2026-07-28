import {
  IsIn,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
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
}
