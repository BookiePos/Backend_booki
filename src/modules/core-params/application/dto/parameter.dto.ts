import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import {
  PARAM_GROUPS,
  PARAM_VALUE_TYPES,
  ParamGroup,
  ParamValueType,
} from '../../domain/params.constants';

/** Crea una clave de parámetro nueva (no de sistema) con su primera vigencia. */
export class CreateParameterDto {
  @IsString()
  @Matches(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, {
    message: 'La clave debe ser en minúsculas tipo grupo.subclave',
  })
  key!: string;

  @IsString()
  label!: string;

  @IsIn(PARAM_GROUPS)
  group!: ParamGroup;

  @IsIn(PARAM_VALUE_TYPES)
  valueType!: ParamValueType;

  // El valor puede ser número, texto o booleano según el tipo.
  @ValidateIf((o: CreateParameterDto) => o.valueType === 'boolean')
  @IsBoolean()
  @ValidateIf((o: CreateParameterDto) => o.valueType !== 'boolean')
  value!: number | string | boolean;

  @IsOptional()
  @IsString()
  unit?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'effectiveFrom debe ser YYYY-MM-DD' })
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

/** Abre una vigencia nueva de un parámetro existente. */
export class SetParameterVersionDto {
  value!: number | string | boolean;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'effectiveFrom debe ser YYYY-MM-DD' })
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  note?: string;
}
