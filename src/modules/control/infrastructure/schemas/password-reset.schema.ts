import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PasswordResetDocument = HydratedDocument<PasswordReset>;

/**
 * Solicitud de recuperación de contraseña.
 *
 * Vive en la base de CONTROL, no en la de la empresa, por la misma razón que el
 * directorio: quien abre el enlace no tiene sesión ni token, así que no hay
 * claim `biz` del que deducir la base. Guardamos aquí el enrutamiento
 * (`businessId`/`dbName`) para poder abrir el `TenantContext` al aplicar la
 * nueva contraseña.
 *
 * Del token solo se guarda su SHA-256: si alguien lee esta colección no puede
 * fabricar enlaces válidos.
 */
@Schema({ timestamps: true, collection: 'password_resets' })
export class PasswordReset {
  /** Correo real al que se envió el enlace. */
  @Prop({ required: true, lowercase: true, trim: true })
  email!: string;

  /** Empresa del usuario, para reabrir su base al restablecer. */
  @Prop({ required: true, trim: true })
  businessId!: string;

  @Prop({ required: true, trim: true })
  dbName!: string;

  /** Id del usuario dentro de la base de su empresa. */
  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true, index: true })
  tokenHash!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  /** Fecha de uso. Un enlace ya usado no sirve dos veces. */
  @Prop()
  usedAt?: Date;
}

export const PasswordResetSchema = SchemaFactory.createForClass(PasswordReset);

// TTL con un día de gracia sobre la expiración: el registro sobrevive un poco
// al vencimiento para poder responder "el enlace expiró" en vez de "no existe",
// que es lo que confunde a quien abre el correo un día tarde.
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });
