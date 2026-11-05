import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Credenciales DIAN de nómina electrónica del emisor. El PIN se cifra antes de
 * guardarse y nunca se devuelve. El ambiente (habilitación/producción) es del
 * emisor y lo decide BookiPos: no se cambia desde aquí.
 */
export class ConfigurarNominaDto {
  @IsUUID(undefined, { message: 'El SoftwareID de nómina debe ser un UUID.' })
  softwareId!: string;

  @IsString()
  @IsNotEmpty({ message: 'Escribe el PIN del software de nómina.' })
  @MaxLength(64)
  pin!: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'El TestSetId de nómina debe ser un UUID.' })
  testSetId?: string;
}
