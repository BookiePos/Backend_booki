import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Campos de texto del multipart de carga del .p12. El archivo va aparte, en el
 * campo `file`. La contraseña se cifra antes de guardarse y nunca se devuelve.
 */
export class CargarCertificadoDto {
  @IsString()
  @IsNotEmpty({ message: 'Escribe la contraseña del certificado.' })
  @MaxLength(256)
  password!: string;
}
