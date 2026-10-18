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
  @Prop({ required: true, lowercase: true, trim: true })
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

  /** Último correo enviado a este buzón: base del enfriamiento de 1 por minuto. */
  @Prop()
  ultimoEnvioAt?: Date;

  /** Correos enviados dentro de la ventana de 24 h que abre `envioDiaInicio`. */
  @Prop({ default: 0 })
  envios?: number;

  @Prop()
  envioDiaInicio?: Date;

  /**
   * Marca de «alguien está creando la empresa con este enlace». Se borra el
   * pendiente solo al terminar bien; si el proceso muere a medias, la marca
   * vence y el enlace se puede volver a usar.
   */
  @Prop()
  consumiendoAt?: Date;
}

export const RegistroPendienteSchema =
  SchemaFactory.createForClass(RegistroPendiente);

// A lo sumo un enlace de confirmación vivo por correo (4.11). Parcial: los
// avisos no llevan token y no compiten con él.
RegistroPendienteSchema.index(
  { email: 1 },
  {
    unique: true,
    name: 'email_confirmacion_unico',
    partialFilterExpression: { tipo: 'confirmacion' },
  },
);

// Mongo borra el pendiente al vencer: no quedan datos de quien nunca confirmó.
RegistroPendienteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
