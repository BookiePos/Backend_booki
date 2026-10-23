import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  REGIMEN_RENTA,
  RegimenRenta,
  RESPONSABILIDAD_FISCAL,
  ResponsabilidadFiscal,
  TIPO_PERSONA,
  TipoPersona,
} from '../../domain/sede.constants';
import { ResolucionFeDto } from './resolucion-fe.dto';

/** QR estático o llave Bre-B del negocio (ítem 6.4). Vacío = quitarlo. */
export class CobroDigitalDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  qrLlave?: string;

  /** Solo imágenes rasterizadas: un SVG puede llevar scripts. */
  @IsOptional()
  @IsString()
  // 70 KB de imagen ≈ 94 000 caracteres en base64: cabe en el cuerpo de 100 KB.
  @MaxLength(95_000, { message: 'La imagen del QR pesa más de 70 KB: usa una más liviana' })
  @Matches(/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)?$/, {
    message: 'qrImagen debe ser una imagen PNG, JPG o WEBP',
  })
  qrImagen?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  qrTitular?: string;
}

export class UpdateSedeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  /** Nombre comercial / marca del negocio (título de la factura). */
  @IsOptional()
  @IsString()
  businessName?: string;

  @IsOptional()
  @IsString()
  address?: string;

  /** NIT / identificación tributaria del negocio. */
  @IsOptional()
  @IsString()
  nit?: string;

  /** Teléfono de contacto del negocio. */
  @IsOptional()
  @IsString()
  phone?: string;

  /** Leyenda legal al pie de la factura. */
  @IsOptional()
  @IsString()
  legalNote?: string;

  // ── Perfil fiscal (factura electrónica) ──────────────────────────────────────
  @IsOptional()
  @IsString()
  nitDv?: string;

  @IsOptional()
  @IsIn(TIPO_PERSONA as readonly string[])
  tipoPersona?: TipoPersona;

  @IsOptional()
  @IsIn(RESPONSABILIDAD_FISCAL as readonly string[])
  responsabilidadFiscal?: ResponsabilidadFiscal;

  // Perfil fiscal completo (ítem 1.17).
  @IsOptional()
  @IsBoolean()
  responsableIva?: boolean;

  @IsOptional()
  @IsBoolean()
  responsableInc?: boolean;

  @IsOptional()
  @IsBoolean()
  franquicia?: boolean;

  @IsOptional()
  @IsIn(REGIMEN_RENTA as readonly string[])
  regimenRenta?: RegimenRenta;

  @IsOptional()
  @IsBoolean()
  granContribuyente?: boolean;

  @IsOptional()
  @IsString()
  ciiu?: string;

  @IsOptional()
  @IsString()
  departamento?: string;

  @IsOptional()
  @IsString()
  ciudad?: string;

  @IsOptional()
  @IsString()
  emailFacturacion?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResolucionFeDto)
  resolucionFe?: ResolucionFeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CobroDigitalDto)
  cobroDigital?: CobroDigitalDto;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
