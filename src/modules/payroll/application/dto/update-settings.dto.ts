import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
} from 'class-validator';
import {
  ArlRates,
  FspTramo,
  RecargoFactores,
  RetTramo,
} from '../../domain/payroll.constants';

/** Actualiza los parámetros de nómina. Todo opcional (merge parcial). */
export class UpdatePayrollSettingsDto {
  @IsOptional() @IsNumber() year?: number;
  @IsOptional() @IsNumber() smmlv?: number;
  @IsOptional() @IsNumber() auxilioTransporte?: number;
  @IsOptional() @IsNumber() uvt?: number;

  @IsOptional() @IsNumber() saludEmpleado?: number;
  @IsOptional() @IsNumber() saludEmpleador?: number;
  @IsOptional() @IsNumber() pensionEmpleado?: number;
  @IsOptional() @IsNumber() pensionEmpleador?: number;

  @IsOptional() @IsNumber() ccf?: number;
  @IsOptional() @IsNumber() sena?: number;
  @IsOptional() @IsNumber() icbf?: number;
  @IsOptional() @IsObject() arlRates?: ArlRates;

  @IsOptional() @IsNumber() ibcMinSmmlv?: number;
  @IsOptional() @IsNumber() ibcMaxSmmlv?: number;
  @IsOptional() @IsNumber() integralSmmlv?: number;
  @IsOptional() @IsNumber() integralIbcFactor?: number;
  @IsOptional() @IsNumber() exoneracionSmmlv?: number;
  @IsOptional() @IsNumber() auxTransporteMaxSmmlv?: number;

  @IsOptional() @IsArray() fspTramos?: FspTramo[];

  @IsOptional() @IsNumber() cesantias?: number;
  @IsOptional() @IsNumber() interesesCesantias?: number;
  @IsOptional() @IsNumber() prima?: number;
  @IsOptional() @IsNumber() vacaciones?: number;

  @IsOptional() @IsArray() tabla383?: RetTramo[];
  @IsOptional() @IsNumber() retencionUmbralUvt?: number;
  @IsOptional() @IsNumber() depMaxUvt?: number;
  @IsOptional() @IsNumber() viviendaMaxUvt?: number;
  @IsOptional() @IsNumber() prepagadaMaxUvt?: number;
  @IsOptional() @IsNumber() rentaExentaPorc?: number;
  @IsOptional() @IsNumber() rentaExentaMaxUvtMes?: number;
  @IsOptional() @IsNumber() limiteGlobalPorc?: number;
  @IsOptional() @IsNumber() limiteGlobalUvtMes?: number;

  @IsOptional() @IsObject() recargos?: RecargoFactores;

  @IsOptional() @IsBoolean() empresaExoneradaAportes?: boolean;
}
