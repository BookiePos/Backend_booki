import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type RegistroPendienteDocument = HydratedDocument<RegistroPendiente>;

/**
 * Alta de empresa que espera la confirmación del correo (ítem 4.11).
 *
 * El registro ya no crea la empresa al instante: responde lo mismo exista o no
 * el correo, para no servir de oráculo, y la empresa nace cuando el dueño abre
 * el enlace que le llegó. Vive en la base de CONTROL porque todavía no hay
 * empresa ni base propia.
 *
 * Del token solo se guarda su SHA-256, y de la contraseña solo su hash bcrypt.
 * `tipo: 'aviso'` marca el correo enviado a quien ya tenía cuenta: no trae
 * token ni datos y solo sirve para no mandar otro durante el enfriamiento.
 */
@Schema({ timestamps: true, collection: 'registros_pendientes' })
export class RegistroPendiente {
  @Prop({ required: true, lowercase: true, trim: true, index: true })
  email!: string;

  @Prop({ required: true, enum: ['confirmacion', 'aviso'] })
  tipo!: 'confirmacion' | 'aviso';

  @Prop({ index: true })
  tokenHash?: string;

  /** Datos del formulario de registro, sin la contraseña. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  datos?: Record<string, unknown>;

  @Prop()
  passwordHash?: string;

  @Prop({ required: true })
  expiresAt!: Date;
}

export const RegistroPendienteSchema =
  SchemaFactory.createForClass(RegistroPendiente);

// Mongo borra el pendiente al vencer: no quedan datos de quien nunca confirmó.
RegistroPendienteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
