import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  DIAN_STATUS,
  DianStatus,
  DOC_TYPES,
  DocType,
} from '../../domain/einvoicing.constants';

/** Datos fiscales del emisor congelados al emitir. */
@Schema({ _id: false })
export class DocEmisor {
  @Prop() name?: string;
  @Prop() nit?: string;
  @Prop() nitDv?: string;
  @Prop() tipoPersona?: string;
  @Prop() responsabilidadFiscal?: string;
  @Prop() ciiu?: string;
  @Prop() address?: string;
  @Prop() departamento?: string;
  @Prop() ciudad?: string;
  @Prop() phone?: string;
  @Prop() email?: string;
}
const DocEmisorSchema = SchemaFactory.createForClass(DocEmisor);

/** Datos del adquiriente congelados al emitir. */
@Schema({ _id: false })
export class DocAdquiriente {
  /** Código DIAN de tipo de documento (13=CC, 31=NIT). */
  @Prop() docType?: string;
  @Prop() docNumber?: string;
  @Prop() name?: string;
  @Prop() phone?: string;
  @Prop() email?: string;
}
const DocAdquirienteSchema = SchemaFactory.createForClass(DocAdquiriente);

/** Línea del documento (con IVA discriminado). */
@Schema({ _id: false })
export class DocLine {
  @Prop() code?: string;
  @Prop({ required: true }) description!: string;
  @Prop({ required: true, min: 0 }) qty!: number;
  /** Código de unidad de medida DIAN (94 = unidad). */
  @Prop({ default: '94' }) unitCode!: string;
  @Prop({ required: true, min: 0 }) unitPrice!: number;
  @Prop({ default: 0, min: 0 }) discountAmount!: number;
  /** Base gravable (sin IVA). */
  @Prop({ required: true, min: 0 }) base!: number;
  @Prop({ default: 0, min: 0 }) ivaRate!: number;
  @Prop({ default: 0, min: 0 }) ivaAmount!: number;
  /** Total de la línea (neto, IVA incluido). */
  @Prop({ required: true, min: 0 }) total!: number;
}
const DocLineSchema = SchemaFactory.createForClass(DocLine);

/** Resolución de numeración DIAN congelada al emitir. */
@Schema({ _id: false })
export class DocResolucion {
  @Prop() numero?: string;
  @Prop() prefijo?: string;
  @Prop() rangoDesde?: number;
  @Prop() rangoHasta?: number;
  @Prop() vigenciaDesde?: Date;
  @Prop() vigenciaHasta?: Date;
}
const DocResolucionSchema = SchemaFactory.createForClass(DocResolucion);

export type ElectronicDocumentDocument = HydratedDocument<ElectronicDocument>;

/**
 * Documento electrónico (factura de venta o nota crédito). Contiene TODO lo que
 * la ley exige, más los campos que el proveedor tecnológico rellena al validar
 * ante la DIAN (cufe, firma, xml, estado). Sin PT queda en estado 'draft'.
 */
@Schema({ timestamps: true, collection: 'electronic_documents' })
export class ElectronicDocument {
  @Prop({ required: true, enum: DOC_TYPES })
  type!: DocType;

  @Prop({ type: Types.ObjectId, ref: 'Sale', index: true })
  saleId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ trim: true, uppercase: true })
  prefix?: string;

  @Prop({ required: true })
  number!: number;

  /** Número completo con prefijo (ej. "FE125"). */
  @Prop({ required: true })
  fullNumber!: string;

  /** Fecha de generación (YYYY-MM-DD). */
  @Prop({ required: true })
  issueDate!: string;

  /** Hora de generación (HH:MM:SS-05:00). */
  @Prop({ required: true })
  issueTime!: string;

  @Prop({ type: DocEmisorSchema })
  emisor?: DocEmisor;

  @Prop({ type: DocAdquirienteSchema })
  adquiriente?: DocAdquiriente;

  @Prop({ type: [DocLineSchema], default: [] })
  lines!: DocLine[];

  @Prop({ default: 0, min: 0 })
  taxableBase!: number;

  @Prop({ default: 0, min: 0 })
  ivaTotal!: number;

  @Prop({ default: 0, min: 0 })
  discountTotal!: number;

  @Prop({ required: true, min: 0 })
  total!: number;

  /** Forma de pago: '1' contado, '2' crédito. */
  @Prop({ default: '1' })
  formaPago!: string;

  /** Medio de pago (código DIAN). */
  @Prop()
  medioPago?: string;

  @Prop({ type: DocResolucionSchema })
  resolution?: DocResolucion;

  // ── Nota crédito ─────────────────────────────────────────────────────────────
  @Prop()
  reason?: string;

  @Prop()
  referenceNumber?: string;

  @Prop()
  referenceCufe?: string;

  @Prop({ type: Types.ObjectId, ref: 'ElectronicDocument' })
  referenceId?: Types.ObjectId;

  // ── DIAN / proveedor tecnológico (se rellenan al validar) ────────────────────
  /** CUFE (facturas) / CUDE (notas). SHA-384 del Anexo 1.9. */
  @Prop()
  cufe?: string;

  @Prop()
  qrUrl?: string;

  @Prop()
  signature?: string;

  @Prop({ required: true, enum: DIAN_STATUS, default: 'draft' })
  dianStatus!: DianStatus;

  @Prop()
  technicalProvider?: string;

  @Prop()
  xmlUrl?: string;

  @Prop({ required: true })
  createdByEmail!: string;
}

export const ElectronicDocumentSchema =
  SchemaFactory.createForClass(ElectronicDocument);

// Un solo documento (no anulado) por venta+tipo.
ElectronicDocumentSchema.index(
  { saleId: 1, type: 1 },
  { unique: true, partialFilterExpression: { saleId: { $exists: true } } },
);
