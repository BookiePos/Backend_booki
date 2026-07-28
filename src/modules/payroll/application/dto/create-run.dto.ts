import {
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Corre la nómina de un período sobre los empleados activos (todos o de una sede). */
export class CreateRunDto {
  @Matches(/^\d{4}-\d{2}$/, { message: 'period debe ser YYYY-MM' })
  period!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsIn(['sede', 'all'])
  coverage?: string;

  @IsOptional()
  @IsMongoId()
  sedeId?: string;
}
