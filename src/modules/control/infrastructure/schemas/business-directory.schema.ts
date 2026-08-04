import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BusinessDirectoryDocument = HydratedDocument<BusinessDirectory>;

/**
 * Directorio global email → empresa. Necesario para enrutar el login: el
 * usuario solo escribe su correo, y con esto sabemos en qué base de datos
 * (empresa) verificar sus credenciales. En v1 un email pertenece a una sola
 * empresa (unicidad global).
 */
@Schema({ timestamps: true, collection: 'business_directory' })
export class BusinessDirectory {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email!: string;

  /**
   * Nombre de usuario para enrutar el login por username. Único a nivel de
   * plataforma (mismo alcance que el email), sparse: solo lo tienen los
   * usuarios creados con acceso por username.
   */
  @Prop({ lowercase: true, trim: true })
  username?: string;

  @Prop({ required: true, trim: true })
  businessId!: string;

  @Prop({ required: true, trim: true })
  dbName!: string;
}

export const BusinessDirectorySchema =
  SchemaFactory.createForClass(BusinessDirectory);

BusinessDirectorySchema.index(
  { username: 1 },
  { unique: true, sparse: true },
);
