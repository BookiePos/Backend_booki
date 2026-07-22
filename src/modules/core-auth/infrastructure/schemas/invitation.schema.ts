import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type InvitationDocument = HydratedDocument<Invitation>;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

/**
 * Invitación para que un nuevo usuario se una al Sistema POS. El dueño la crea con un
 * correo + rol; se envía por email un enlace con un token (guardamos solo su
 * hash). Al aceptarlo, el invitado define su contraseña y se crea el usuario.
 */
@Schema({ timestamps: true, collection: 'invitations' })
export class Invitation {
  @Prop({ required: true, lowercase: true, trim: true })
  email!: string;

  /** Key del rol que tendrá el usuario al aceptar. */
  @Prop({ required: true, trim: true })
  role!: string;

  /** SHA-256 del token enviado en el enlace (el token en claro nunca se guarda). */
  @Prop({ required: true, index: true })
  tokenHash!: string;

  @Prop({
    required: true,
    enum: ['pending', 'accepted', 'revoked'],
    default: 'pending',
  })
  status!: InvitationStatus;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  invitedBy?: Types.ObjectId;

  @Prop()
  acceptedAt?: Date;
}

export const InvitationSchema = SchemaFactory.createForClass(Invitation);
