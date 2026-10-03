import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  ACCOUNT_STEPS,
  AccountStep,
  EINVOICE_ENVIRONMENTS,
  EinvoiceEnvironmentName,
} from '../../domain/einvoicing.constants';

export type EinvoicingAccountDocument = HydratedDocument<EinvoicingAccount>;

/**
 * Conexión de un NIT con el facturador (APIDIAN).
 *
 * Una por NIT, no por sede: la DIAN habilita al CONTRIBUYENTE. Las sedes que
 * comparten NIT comparten esta conexión y cada una pone su propia resolución
 * (con su prefijo).
 *
 * Lo sensible no se guarda en claro:
 * - el token de la empresa en APIDIAN va cifrado (`tokenSealed`), con la llave
 *   del entorno;
 * - el certificado digital (.p12) y su clave NO se guardan aquí: se le pasan a
 *   APIDIAN y se descartan. Solo queda la fecha de vencimiento, para avisar.
 */
@Schema({ timestamps: true, collection: 'einvoicing_accounts' })
export class EinvoicingAccount {
  /** NIT sin DV ni puntos. */
  @Prop({ required: true, unique: true, trim: true })
  nit!: string;

  @Prop({ trim: true })
  dv?: string;

  /** Token de la empresa en el facturador, cifrado con `SecretBox`. */
  @Prop()
  tokenSealed?: string;

  @Prop({ required: true, enum: EINVOICE_ENVIRONMENTS, default: 'habilitacion' })
  environment!: EinvoiceEnvironmentName;

  /** Hasta dónde llegó la habilitación. */
  @Prop({ required: true, enum: ACCOUNT_STEPS, default: 'empresa' })
  step!: AccountStep;

  /** ID del software propio registrado en la DIAN. El PIN no se guarda. */
  @Prop({ trim: true })
  softwareId?: string;

  /** ID del set de pruebas que entregó la DIAN (solo en habilitación). */
  @Prop({ trim: true })
  testSetId?: string;

  @Prop()
  certificateExpiresAt?: Date;

  /** Último error de configuración, para mostrarlo en el asistente. */
  @Prop()
  lastError?: string;

  @Prop()
  updatedByEmail?: string;
}

export const EinvoicingAccountSchema =
  SchemaFactory.createForClass(EinvoicingAccount);
