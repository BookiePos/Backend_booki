import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;

/**
 * Registro de refresh tokens emitidos, para poder revocarlos y rotarlos.
 * El `jti` es el identificador único del token (va dentro del JWT de refresh).
 */
@Schema({ timestamps: true, collection: 'refresh_tokens' })
export class RefreshToken {
  @Prop({ required: true, unique: true })
  jti!: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ default: false })
  revoked!: boolean;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);

// TTL: Mongo elimina automáticamente cada registro cuando pasa su expiresAt.
// Un token cuyo registro ya no existe se rechaza igual que uno revocado.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
