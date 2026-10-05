import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  ACCOUNT_STEPS,
  AccountStep,
  EINVOICE_ENVIRONMENTS,
  EinvoiceEnvironmentName,
} from '../../domain/einvoicing.constants';

export type EinvoicingAccountDocument = HydratedDocument<EinvoicingAccount>;

/** Un documento del set de pruebas y lo que respondió la DIAN. */
@Schema({ _id: false })
export class TestSetDocEntry {
  @Prop({ required: true, enum: ['invoice', 'credit_note', 'debit_note'] })
  kind!: 'invoice' | 'credit_note' | 'debit_note';

  @Prop({ required: true })
  prefix!: string;

  @Prop({ required: true })
  number!: number;

  @Prop()
  cufe?: string;

  /** Llave para consultar el resultado del envío asíncrono. */
  @Prop()
  zipKey?: string;

  @Prop({ required: true, enum: ['pending', 'accepted', 'rejected'], default: 'pending' })
  status!: 'pending' | 'accepted' | 'rejected';

  @Prop()
  message?: string;

  /** Reglas incumplidas. No se llama `errors`: Mongoose reserva ese nombre. */
  @Prop({ type: [String], default: [] })
  dianErrors!: string[];
}
const TestSetDocEntrySchema = SchemaFactory.createForClass(TestSetDocEntry);

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

  // ── Set de pruebas (habilitación) ──────────────────────────────────────────
  /** Documentos del último envío del set, con su estado ante la DIAN. */
  @Prop({ type: [TestSetDocEntrySchema], default: [] })
  testSetDocs!: TestSetDocEntry[];

  @Prop()
  testSetSentAt?: Date;

  /**
   * Números de prueba ya usados. Cada envío del set usa números nuevos: la
   * DIAN rechaza un número que ya recibió ("procesado anteriormente").
   */
  @Prop({ default: 0, min: 0 })
  testSetInvoiceSeq!: number;

  @Prop({ default: 0, min: 0 })
  testSetNoteSeq!: number;

  /** Último error de configuración, para mostrarlo en el asistente. */
  @Prop()
  lastError?: string;

  @Prop()
  updatedByEmail?: string;
}

export const EinvoicingAccountSchema =
  SchemaFactory.createForClass(EinvoicingAccount);
