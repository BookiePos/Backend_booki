import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { TAX_KINDS, TaxKind } from '../../domain/tax.constants';

/** Crea un impuesto nuevo con su primera vigencia. */
export class CreateTaxDto {
  @IsString()
  @Matches(/^[A-Z0-9_]+$/, { message: 'El código debe ser MAYÚSCULAS_CON_GUION_BAJO' })
  code!: string;

  @IsString()
  name!: string;

  @IsIn(TAX_KINDS)
  kind!: TaxKind;

  @IsNumber()
  @Min(0)
  @Max(100)
  rate!: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'effectiveFrom debe ser YYYY-MM-DD' })
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

/** Abre una vigencia nueva (tarifa) de un impuesto existente. */
export class SetTaxRateVersionDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  rate!: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'effectiveFrom debe ser YYYY-MM-DD' })
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateTaxDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
