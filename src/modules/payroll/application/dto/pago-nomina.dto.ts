import { IsIn, IsOptional, Matches } from 'class-validator';
import { MEDIOS_PAGO_NOMINA } from '../../domain/pago-nomina';

/** Medio y fecha real del pago de una corrida (decisión 1 del dueño). */
export class PagoNominaDto {
  @IsIn(MEDIOS_PAGO_NOMINA as readonly string[], { message: 'medioPago debe ser 10, 20, 42 o 47' })
  medioPago!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fechaPago debe ser YYYY-MM-DD' })
  fechaPago!: string;
}

/** Cierre de la corrida: el pago es opcional aquí (se puede declarar después), pero si viene, completo. */
export class CerrarRunDto {
  @IsOptional()
  @IsIn(MEDIOS_PAGO_NOMINA as readonly string[], { message: 'medioPago debe ser 10, 20, 42 o 47' })
  medioPago?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fechaPago debe ser YYYY-MM-DD' })
  fechaPago?: string;
}
