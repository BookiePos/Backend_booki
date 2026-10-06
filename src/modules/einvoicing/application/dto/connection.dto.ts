import {
  IsBase64,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { EINVOICE_ENVIRONMENTS } from '../../domain/einvoicing.constants';
import type { EinvoiceEnvironmentName } from '../../domain/einvoicing.constants';

/** Crear la empresa en el facturador con los datos fiscales de una sede. */
export class RegisterCompanyDto {
  @IsMongoId()
  sedeId!: string;
}

/**
 * Certificado digital de la empresa (.p12 / .pfx) en base64, con su clave.
 *
 * Pasa directo al facturador: BookiPos no lo guarda. 64 KB de base64 sobran
 * para un certificado real (pesan 3 a 8 KB).
 */
export class UploadCertificateDto {
  @IsBase64()
  @MaxLength(64_000)
  certificate!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}

/** Software propio registrado en el portal de la DIAN. */
export class ConfigureSoftwareDto {
  /** ID del software (un UUID que entrega la DIAN). */
  @IsString()
  @Matches(/^[0-9a-fA-F-]{36}$/, { message: 'El ID del software es un UUID de 36 caracteres.' })
  softwareId!: string;

  /** PIN de 5 dígitos que se escogió al registrar el software. */
  @Matches(/^\d{5}$/, { message: 'El PIN del software tiene 5 dígitos.' })
  pin!: string;

  /** ID del set de pruebas (UUID) que entrega la DIAN para la habilitación. */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F-]{36}$/, { message: 'El ID del set de pruebas es un UUID de 36 caracteres.' })
  testSetId?: string;
}

export class SetEnvironmentDto {
  @IsIn(EINVOICE_ENVIRONMENTS as readonly string[])
  environment!: EinvoiceEnvironmentName;
}
