import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Role } from '../../domain/roles';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email!: string;

  /**
   * Nombre de usuario para iniciar sesión (alternativa al email). Único por
   * empresa. Cuando se crea un acceso desde un empleado, se genera un email
   * sintético `<username>@<businessId>.local` para reusar el enrutamiento por
   * email; la persona inicia sesión con este `username`.
   */
  @Prop({ lowercase: true, trim: true })
  username?: string;

  @Prop({ required: true })
  passwordHash!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  // La clave de rol es dinámica (colección `roles`); se valida en el servicio.
  @Prop({ required: true, default: 'cashier', lowercase: true, trim: true })
  role!: Role;

  /** Permisos extra además de los del rol (granularidad fina). */
  @Prop({ type: [String], default: [] })
  extraPermissions!: string[];

  /** Sedes a las que el usuario tiene acceso (multi-sede). */
  @Prop({ type: [Types.ObjectId], ref: 'Sede', default: [] })
  sedeIds!: Types.ObjectId[];

  @Prop({ default: true })
  active!: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Username único por empresa (sparse: los usuarios sin username no chocan).
UserSchema.index({ username: 1 }, { unique: true, sparse: true });
