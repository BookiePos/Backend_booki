import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RoleDocument = HydratedDocument<Role>;

/**
 * Rol persistido. La `key` es un slug único (p.ej. "cajero-tarde"); el `name`
 * es el nombre visible. Los roles de sistema (`isSystem`) no se pueden borrar.
 */
@Schema({ timestamps: true, collection: 'roles' })
export class Role {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  key!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ default: '' })
  description!: string;

  @Prop({ type: [String], default: [] })
  permissions!: string[];

  @Prop({ default: false })
  isSystem!: boolean;
}

export const RoleSchema = SchemaFactory.createForClass(Role);
