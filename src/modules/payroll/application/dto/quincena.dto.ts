import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MEDIOS_PAGO_NOMINA } from '../../domain/pago-nomina';

/** A quién y cuánto. El servidor recalcula; `neto` solo sirve para pagar MENOS de lo calculado. */
export class LineaQuincenaDto {
  @IsMongoId()
  employeeId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  neto?: number;
}

export class RegistrarQuincenaDto {
  @Matches(/^\d{4}-\d{2}$/, { message: 'period debe ser YYYY-MM' })
  period!: string;

  @IsIn(['all', 'sede'])
  coverage!: string;

  @IsOptional()
  @IsMongoId()
  sedeId?: string;

  @IsIn(MEDIOS_PAGO_NOMINA as readonly string[], { message: 'medioPago debe ser 10, 20, 42 o 47' })
  medioPago!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fechaPago debe ser YYYY-MM-DD' })
  fechaPago!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LineaQuincenaDto)
  lineas!: LineaQuincenaDto[];
}

export class AnularQuincenaDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  motivo?: string;
}
