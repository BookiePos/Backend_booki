import {
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
} from 'class-validator';
import {
  DEDUCTION_SOURCES,
  DeductionSource,
} from '../../infrastructure/schemas/payroll-deduction.schema';

/** Crea una deducción/consumo de empleado (queda pendiente de aprobación). */
export class CreateDeductionDto {
  @IsMongoId()
  employeeId!: string;

  @IsString()
  @MinLength(1)
  concept!: string;

  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date debe ser YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsIn(DEDUCTION_SOURCES)
  source?: DeductionSource;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
