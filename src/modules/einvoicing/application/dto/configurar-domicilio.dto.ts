import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Domicilio fiscal del emisor, tal como sale en el RUT. Uno por NIT: vale para
 * todas las sedes que lo comparten.
 */
export class ConfigurarDomicilioDto {
  @Transform(recortar)
  @IsString()
  @IsNotEmpty({ message: 'Escribe la dirección del RUT.' })
  @MaxLength(200)
  direccion!: string;

  /** El servicio comprueba que exista en el catálogo DANE. */
  @Transform(recortar)
  @Matches(/^\d{5}$/, { message: 'Elige el municipio de la lista.' })
  municipioDane!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'El correo de facturación no es válido.' })
  @MaxLength(200)
  emailFacturacion?: string;
}
