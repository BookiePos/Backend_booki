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
  DEDUCTION_SOURCES_API,
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
  // El arrastre del saldo a cargo lo crea el cierre de la nómina, no la API.
  @IsIn(DEDUCTION_SOURCES_API)
  source?: Exclude<DeductionSource, 'arrastre'>;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
