import { IsMongoId, IsOptional, IsString, Matches, ValidateIf } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fija las horas de un empleado en un día desde Operación. A diferencia del
 * registro del POS (write-once), aquí un administrador puede sobrescribir o
 * limpiar (mandando cadena vacía) las horas ya registradas.
 */
export class AdminSetAttendanceDto {
  @IsMongoId()
  sedeId!: string;

  @IsMongoId()
  employeeId!: string;

  @Matches(YYYYMMDD, { message: 'workDate debe ser YYYY-MM-DD' })
  workDate!: string;

  // "" = limpiar; HH:MM = fijar; undefined = no tocar.
  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v != null)
  @Matches(HHMM, { message: 'checkIn debe ser HH:MM' })
  checkIn?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v != null)
  @Matches(HHMM, { message: 'checkOut debe ser HH:MM' })
  checkOut?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
