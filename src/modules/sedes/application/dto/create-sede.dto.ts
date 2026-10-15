import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
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

export class CreateSedeDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

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
}
