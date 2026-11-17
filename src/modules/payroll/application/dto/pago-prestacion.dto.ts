import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { MEDIOS_PAGO_NOMINA } from '../../domain/pago-nomina';
import { DESTINOS_CESANTIAS, TIPOS_PRESTACION } from '../../domain/pago-prestacion';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/** Registra el pago de prima, cesantías o intereses sobre cesantías (decisión 2 del dueño). */
export class RegistrarPagoPrestacionDto {
  @IsMongoId()
  employeeId!: string;

  @IsIn(TIPOS_PRESTACION as readonly string[])
  tipo!: string;

  /** Lo pagado en pesos enteros, antes de la retención. */
  @IsInt()
  @Min(1)
  monto!: number;

  /** Retención en la fuente practicada sobre la prima (pesos). */
  @IsOptional()
  @IsInt()
  @Min(0)
  retencionFuente?: number;

  @Matches(YYYYMMDD, { message: 'periodoDesde debe ser YYYY-MM-DD' })
  periodoDesde!: string;

  @Matches(YYYYMMDD, { message: 'periodoHasta debe ser YYYY-MM-DD' })
  periodoHasta!: string;

  @IsIn(MEDIOS_PAGO_NOMINA as readonly string[], { message: 'medioPago debe ser 10, 20, 42 o 47' })
  medioPago!: string;

  @Matches(YYYYMMDD, { message: 'fechaPago debe ser YYYY-MM-DD' })
  fechaPago!: string;

  /** Solo cesantías: fondo (por defecto) o trabajador. */
  @IsOptional()
  @IsIn(DESTINOS_CESANTIAS as readonly string[])
  destino?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  fondo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  observacion?: string;
}

export class AnularPagoPrestacionDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  motivo?: string;
}
