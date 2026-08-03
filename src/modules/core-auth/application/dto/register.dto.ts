import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import {
  BUSINESS_PLANS,
  BUSINESS_TYPES,
  BusinessPlan,
  BusinessType,
} from '../../../control/domain/control.constants';
import {
  RESPONSABILIDAD_FISCAL,
  ResponsabilidadFiscal,
  TIPO_PERSONA,
  TipoPersona,
} from '../../../sedes/domain/sede.constants';

/**
 * Alta pública de una empresa (tenant) desde la web. Recoge la identidad del
 * negocio (que se guarda en su primera sede) y la cuenta del dueño.
 */
export class RegisterDto {
  // ── Negocio ────────────────────────────────────────────────────────────────
  @IsString()
  @MinLength(1)
  businessName!: string;

  @IsIn(BUSINESS_PLANS as readonly string[])
  plan!: BusinessPlan;

  @IsIn(BUSINESS_TYPES as readonly string[])
  tipoNegocio!: BusinessType;

  @IsOptional()
  @IsString()
  nit?: string;

  @IsOptional()
  @IsString()
  nitDv?: string;

  @IsOptional()
  @IsIn(TIPO_PERSONA as readonly string[])
  tipoPersona?: TipoPersona;

  @IsOptional()
  @IsIn(RESPONSABILIDAD_FISCAL as readonly string[])
  responsabilidadFiscal?: ResponsabilidadFiscal;

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
  address?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  emailFacturacion?: string;

  // ── Dueño ──────────────────────────────────────────────────────────────────
  @IsString()
  @MinLength(1)
  ownerName!: string;

  @IsEmail()
  ownerEmail!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
