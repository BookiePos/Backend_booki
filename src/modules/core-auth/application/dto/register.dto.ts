import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsStrongPassword,
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
import { POLITICA_CONTRASENA } from './password-policy';

/**
 * Alta pública de una empresa (tenant) desde la web. Recoge la identidad del
 * negocio (que se guarda en su primera sede) y la cuenta del dueño.
 */
/** Respuesta a «¿Cobras IVA?» del registro corto (ítem 6.5). */
export const COBRA_IVA = ['si', 'no', 'no_se'] as const;
export type CobraIva = (typeof COBRA_IVA)[number];

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

  /**
   * «¿Cobras IVA?». `no` deja la sede como no responsable de IVA; `si` como
   * responsable; `no_se` o vacío, sin dato (la venta usa el default
   * conservador). Una `responsabilidadFiscal` explícita gana.
   */
  @IsOptional()
  @IsIn(COBRA_IVA as readonly string[])
  cobraIva?: CobraIva;

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
  @IsStrongPassword(POLITICA_CONTRASENA)
  password!: string;
}
