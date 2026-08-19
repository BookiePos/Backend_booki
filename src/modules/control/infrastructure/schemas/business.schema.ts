import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  BUSINESS_PLANS,
  BUSINESS_STATUSES,
  BUSINESS_TYPES,
  BusinessPlan,
  BusinessStatus,
  BusinessType,
} from '../../domain/control.constants';
import type { BusinessAddOns } from '../../domain/plans';

export type BusinessDocument = HydratedDocument<Business>;

/**
 * Empresa (tenant). Vive en la base de control compartida (`gocheck_control`),
 * NO en la base de la empresa. Solo guarda el registro de la cuenta y a qué
 * base de datos (`dbName`) apuntan sus datos operativos.
 */
@Schema({ timestamps: true, collection: 'businesses' })
export class Business {
  /** Nombre comercial del negocio. */
  @Prop({ required: true, trim: true })
  name!: string;

  /** NIT / identificación tributaria (único a nivel plataforma). */
  @Prop({ trim: true })
  nit?: string;

  @Prop({ required: true, enum: BUSINESS_PLANS })
  plan!: BusinessPlan;

  @Prop({ required: true, enum: BUSINESS_TYPES })
  tipoNegocio!: BusinessType;

  @Prop({ required: true, enum: BUSINESS_STATUSES, default: 'trial' })
  status!: BusinessStatus;

  @Prop()
  trialEndsAt?: Date;

  /** Base de datos donde viven los datos operativos: `biz_<_id>`. */
  @Prop({ required: true, unique: true, trim: true })
  dbName!: string;

  /** Correo del dueño que dio de alta la empresa. */
  @Prop({ required: true, lowercase: true, trim: true })
  ownerEmail!: string;

  /** Complementos contratados (nómina, sedes extra, paquetes de documentos). */
  @Prop({ type: Object, default: {} })
  addOns?: BusinessAddOns;
}

export const BusinessSchema = SchemaFactory.createForClass(Business);
