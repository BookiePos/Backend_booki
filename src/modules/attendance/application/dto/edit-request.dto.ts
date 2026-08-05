import {
  IsBoolean,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Un trabajador solicita corregir sus horas ya registradas de un día. */
export class CreateEditRequestDto {
  @IsMongoId()
  sedeId!: string;

  @IsMongoId()
  employeeId!: string;

  @Matches(YYYYMMDD, { message: 'workDate debe ser YYYY-MM-DD' })
  workDate!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v != null)
  @Matches(HHMM, { message: 'proposedCheckIn debe ser HH:MM' })
  proposedCheckIn?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v != null)
  @Matches(HHMM, { message: 'proposedCheckOut debe ser HH:MM' })
  proposedCheckOut?: string;

  @IsString()
  @MinLength(3, { message: 'Explica el motivo del cambio' })
  @MaxLength(300)
  reason!: string;
}

/** Aprueba o rechaza una solicitud de edición (Operación). */
export class ResolveEditRequestDto {
  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
