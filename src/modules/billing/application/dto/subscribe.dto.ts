import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BUSINESS_PLANS } from '../../../control/domain/plans';
import { BILLING_CYCLES } from '../../domain/billing.constants';

/** Complementos recurrentes que el dueño puede contratar junto al plan. */
export class SubscribeAddOnsDto {
  @IsOptional()
  @IsBoolean()
  payroll?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  extraSedes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  extraEmployees?: number;
}

/**
 * Alta o cambio de suscripción. El frontend tokeniza la tarjeta con la llave
 * pública (Wompi) y envía aquí el `cardToken` + `acceptanceToken`.
 */
export class SubscribeDto {
  @IsIn(BUSINESS_PLANS as readonly string[])
  plan!: string;

  @IsOptional()
  @IsIn(BILLING_CYCLES as readonly string[])
  billingCycle?: string;

  @IsString()
  @MinLength(3)
  cardToken!: string;

  @IsString()
  @MinLength(3)
  acceptanceToken!: string;

  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SubscribeAddOnsDto)
  addOns?: SubscribeAddOnsDto;
}
