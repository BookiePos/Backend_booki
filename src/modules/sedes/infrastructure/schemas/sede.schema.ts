import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  RESPONSABILIDAD_FISCAL,
  ResponsabilidadFiscal,
  TIPO_PERSONA,
  TipoPersona,
} from '../../domain/sede.constants';

export type SedeDocument = HydratedDocument<Sede>;

/**
 * Resolución de numeración de factura electrónica autorizada por la DIAN.
 * Requerida para emitir: prefijo, rango, vigencia y clave técnica.
 */
@Schema({ _id: false })
export class ResolucionFe {
  @Prop({ trim: true })
  numero?: string;

  @Prop()
  fechaResolucion?: Date;

  @Prop({ trim: true, uppercase: true })
  prefijo?: string;

  @Prop({ min: 0 })
  rangoDesde?: number;

  @Prop({ min: 0 })
  rangoHasta?: number;

  @Prop()
  vigenciaDesde?: Date;

  @Prop()
  vigenciaHasta?: Date;

  /** Clave técnica entregada por la DIAN (para el CUFE). */
  @Prop({ trim: true })
  claveTecnica?: string;
}
const ResolucionFeSchema = SchemaFactory.createForClass(ResolucionFe);

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

  // ── Perfil fiscal del emisor (factura electrónica) ───────────────────────────
  /** Dígito de verificación del NIT. */
  @Prop({ trim: true })
  nitDv?: string;

  @Prop({ enum: TIPO_PERSONA })
  tipoPersona?: TipoPersona;

  @Prop({ enum: RESPONSABILIDAD_FISCAL })
  responsabilidadFiscal?: ResponsabilidadFiscal;

  /** Código CIIU de actividad económica. */
  @Prop({ trim: true })
  ciiu?: string;

  @Prop({ trim: true })
  departamento?: string;

  @Prop({ trim: true })
  ciudad?: string;

  /** Correo desde/para facturación electrónica. */
  @Prop({ trim: true, lowercase: true })
  emailFacturacion?: string;

  /** Resolución de numeración DIAN vigente. */
  @Prop({ type: ResolucionFeSchema })
  resolucionFe?: ResolucionFe;

  @Prop({ default: true })
  active!: boolean;
}

export const SedeSchema = SchemaFactory.createForClass(Sede);
