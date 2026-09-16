import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Registro de la tarjeta sin cobrar nada. El frontend la captura con el widget
 * oficial de Wompi (modo `tokenize`) y manda aquí el token de un uso junto con
 * las aceptaciones; el backend lo cambia por una fuente de pago permanente.
 */
export class SavePaymentMethodDto {
  @IsString()
  @MinLength(3)
  cardToken!: string;

  @IsString()
  @MinLength(3)
  acceptanceToken!: string;

  /** Autorización de tratamiento de datos personales (Wompi la exige aparte). */
  @IsOptional()
  @IsString()
  @MinLength(3)
  acceptPersonalAuth?: string;

  @IsOptional()
  @IsEmail()
  customerEmail?: string;
}
