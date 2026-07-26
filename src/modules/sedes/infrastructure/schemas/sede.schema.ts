import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SedeDocument = HydratedDocument<Sede>;

@Schema({ timestamps: true, collection: 'sedes' })
export class Sede {
  @Prop({ required: true, unique: true, trim: true })
  code!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  /** Nombre comercial / marca del negocio (título de la factura). */
  @Prop({ trim: true })
  businessName?: string;

  @Prop({ trim: true })
  address?: string;

  /** NIT / identificación tributaria del negocio (encabezado de factura). */
  @Prop({ trim: true })
  nit?: string;

  /** Teléfono de contacto del negocio (encabezado de factura). */
  @Prop({ trim: true })
  phone?: string;

  /** Leyenda legal al pie de la factura (régimen, resolución, etc.). */
  @Prop({ trim: true })
  legalNote?: string;

  @Prop({ default: true })
  active!: boolean;
}

export const SedeSchema = SchemaFactory.createForClass(Sede);
