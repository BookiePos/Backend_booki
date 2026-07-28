import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import {
  ArlRates,
  FspTramo,
  RecargoFactores,
  RetTramo,
} from '../../domain/payroll.constants';

export type PayrollSettingsDocument = HydratedDocument<PayrollSettings>;

/**
 * Parámetros de nómina vigentes (singleton). Un solo documento por instancia;
 * el servicio lo crea con los valores por defecto (2026) si no existe.
 */
@Schema({ timestamps: true, collection: 'payroll_settings' })
export class PayrollSettings {
  @Prop({ required: true, default: 2026 })
  year!: number;

  @Prop({ required: true })
  smmlv!: number;

  @Prop({ required: true })
  auxilioTransporte!: number;

  @Prop({ required: true })
  uvt!: number;

  @Prop({ required: true })
  saludEmpleado!: number;

  @Prop({ required: true })
  saludEmpleador!: number;

  @Prop({ required: true })
  pensionEmpleado!: number;

  @Prop({ required: true })
  pensionEmpleador!: number;

  @Prop({ required: true })
  ccf!: number;

  @Prop({ required: true })
  sena!: number;

  @Prop({ required: true })
  icbf!: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  arlRates!: ArlRates;

  @Prop({ required: true })
  ibcMinSmmlv!: number;

  @Prop({ required: true })
  ibcMaxSmmlv!: number;

  @Prop({ required: true })
  integralSmmlv!: number;

  @Prop({ required: true })
  integralIbcFactor!: number;

  @Prop({ required: true })
  exoneracionSmmlv!: number;

  @Prop({ required: true })
  auxTransporteMaxSmmlv!: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  fspTramos!: FspTramo[];

  @Prop({ required: true })
  cesantias!: number;

  @Prop({ required: true })
  interesesCesantias!: number;

  @Prop({ required: true })
  prima!: number;

  @Prop({ required: true })
  vacaciones!: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  tabla383!: RetTramo[];

  @Prop({ required: true })
  retencionUmbralUvt!: number;

  @Prop({ required: true })
  depMaxUvt!: number;

  @Prop({ required: true })
  viviendaMaxUvt!: number;

  @Prop({ required: true })
  prepagadaMaxUvt!: number;

  @Prop({ required: true })
  rentaExentaPorc!: number;

  @Prop({ required: true })
  rentaExentaMaxUvtMes!: number;

  @Prop({ required: true })
  limiteGlobalPorc!: number;

  @Prop({ required: true })
  limiteGlobalUvtMes!: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  recargos!: RecargoFactores;

  @Prop({ required: true, default: true })
  empresaExoneradaAportes!: boolean;
}

export const PayrollSettingsSchema =
  SchemaFactory.createForClass(PayrollSettings);
