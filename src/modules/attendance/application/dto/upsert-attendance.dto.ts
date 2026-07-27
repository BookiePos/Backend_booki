import { IsMongoId, IsOptional, IsString, Matches } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Registra/actualiza las horas de un trabajador en una sede y día. */
export class UpsertAttendanceDto {
  @IsMongoId()
  sedeId!: string;

  @IsMongoId()
  userId!: string;

  @Matches(YYYYMMDD, { message: 'workDate debe ser YYYY-MM-DD' })
  workDate!: string;

  @IsOptional()
  @Matches(HHMM, { message: 'checkIn debe ser HH:MM' })
  checkIn?: string;

  @IsOptional()
  @Matches(HHMM, { message: 'checkOut debe ser HH:MM' })
  checkOut?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
