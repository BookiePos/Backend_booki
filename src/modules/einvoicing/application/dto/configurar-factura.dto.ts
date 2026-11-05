import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Credenciales DIAN de factura electrónica del emisor. El PIN se cifra antes de
 * guardarse y nunca se devuelve. El ambiente (habilitación/producción) es del
 * emisor y lo decide BookiPos: no se cambia desde aquí.
 */
export class ConfigurarFacturaDto {
  @Transform(recortar)
  @IsUUID(undefined, { message: 'El SoftwareID de factura debe ser un UUID.' })
  softwareId!: string;

  // Se recorta antes de validar: un PIN de solo espacios queda vacío y no pasa.
  @Transform(recortar)
  @IsString()
  @IsNotEmpty({ message: 'Escribe el PIN del software de factura.' })
  @MaxLength(64)
  pin!: string;

  /** Ausente no toca el guardado; `null` lo borra. */
  @IsOptional()
  @Transform(recortar)
  @IsUUID(undefined, { message: 'El TestSetId de factura debe ser un UUID.' })
  testSetId?: string | null;
}
