import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  DIAN_STATUS,
  DianStatus,
  DOC_TYPES,
  DocType,
} from '../../domain/einvoicing.constants';
import {
  INDICE_CONSECUTIVO_UNICO,
  INDICE_EXCLUSION_FISCAL,
} from '../../domain/consecutivo-unico';

/** Datos fiscales del emisor congelados al emitir. */
@Schema({ _id: false })
export class DocEmisor {
  @Prop() name?: string;
  @Prop() nit?: string;
  /** NIT base sin DV y solo dígitos (ver `normalizarNit`): llave del consecutivo único. */
  @Prop() nitNorm?: string;
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
  @Prop() nitDv?: string;
  /** 1 = jurídica, 2 = natural. */
  @Prop() tipoPersona?: string;
  @Prop({ type: [String] }) responsabilidades?: string[];
  @Prop() regimen?: string;
  /** Código DANE del municipio (5 dígitos). */
  @Prop() municipioDane?: string;
  @Prop() address?: string;
}
const DocAdquirienteSchema = SchemaFactory.createForClass(DocAdquiriente);

/** Tributo por unidad de una línea (INC de bolsas, código 22). */
@Schema({ _id: false })
export class DocPerUnitTax {
  @Prop({ required: true }) codigo!: string;
  @Prop({ required: true, min: 0 }) unidades!: number;
  @Prop({ required: true, min: 0 }) valorUnitario!: number;
  @Prop({ required: true, min: 0 }) valor!: number;
}
const DocPerUnitTaxSchema = SchemaFactory.createForClass(DocPerUnitTax);

/** Línea del documento, con su tributo real (`taxScheme`). */
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
  /**
   * Tributo de la línea: '01' IVA o '04' INC; vacío = sin tributo. Los
   * documentos anteriores no lo tienen (su impuesto quedó en `ivaAmount`).
   */
  @Prop() taxScheme?: string;
  @Prop({ min: 0 }) taxRate?: number;
  @Prop({ min: 0 }) taxAmount?: number;
  /** INC de bolsas (tributo 22), aparte del impuesto ad valorem. */
  @Prop({ type: DocPerUnitTaxSchema }) perUnitTax?: DocPerUnitTax;
  /** Total de la línea (base + impuestos). */
  @Prop({ required: true, min: 0 }) total!: number;
}
const DocLineSchema = SchemaFactory.createForClass(DocLine);

/** Cargo o descuento de documento (AllowanceCharge). Hoy: la propina. */
@Schema({ _id: false })
export class DocCharge {
  @Prop({ required: true }) chargeIndicator!: boolean;
  @Prop({ required: true }) reason!: string;
  @Prop({ required: true, min: 0 }) amount!: number;
}
const DocChargeSchema = SchemaFactory.createForClass(DocCharge);

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

/** Caja del POS (`InformacionCajaVenta`, anexo DE §8.2.1), congelada al emitir. */
@Schema({ _id: false })
export class DocCajaVenta {
  @Prop() placa?: string;
  @Prop() ubicacion?: string;
  @Prop() tipo?: string;
  @Prop() cajero?: string;
  @Prop() codigoVenta?: string;
}
const DocCajaVentaSchema = SchemaFactory.createForClass(DocCajaVenta);

/** Fabricante del software (`InformacionDelFabricanteDelSoftware`), congelado al emitir. */
@Schema({ _id: false })
export class DocFabricante {
  @Prop() nombreApellido?: string;
  @Prop() razonSocial?: string;
  @Prop() nit?: string;
  @Prop() nombreSoftware?: string;
}
const DocFabricanteSchema = SchemaFactory.createForClass(DocFabricante);

/**
 * Una parte del pago del POS (`PaymentMeans` 1..N). Va el medio de BookiPos;
 * el código DIAN lo pone el builder (ver `domain/emision-pos.ts`).
 */
@Schema({ _id: false })
export class DocPago {
  @Prop({ required: true }) metodo!: string;
  @Prop({ required: true, min: 0 }) monto!: number;
  @Prop({ required: true }) formaPago!: string;
  @Prop() tipoTarjeta?: string;
  @Prop() canal?: string;
  @Prop() vence?: string;
}
const DocPagoSchema = SchemaFactory.createForClass(DocPago);

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

  /** LineExtensionAmount: Σ bases de las líneas (ValFac del CUFE). */
  @Prop({ default: 0, min: 0 })
  taxableBase!: number;

  /** Σ tributo 01. En documentos anteriores a la Fase 2 incluye el INC. */
  @Prop({ default: 0, min: 0 })
  ivaTotal!: number;

  // ── Totales por tributo y cargos (Fase 2). Ausentes en documentos viejos ──
  /** TaxExclusiveAmount: Σ bases de las líneas con TaxTotal, incluidas las exentas (FAU04). */
  @Prop({ min: 0 })
  taxExclusiveAmount?: number;

  /** Σ tributo 04 (INC). */
  @Prop({ min: 0 })
  incTotal?: number;

  /** Σ tributo 03 (ICA). */
  @Prop({ min: 0 })
  icaTotal?: number;

  /** Σ tributo 22 (INC de bolsas). */
  @Prop({ min: 0 })
  bagTaxTotal?: number;

  /** TaxInclusiveAmount: bases + todos los tributos. */
  @Prop({ min: 0 })
  taxInclusiveAmount?: number;

  /** Cargos de documento no gravados (la propina). */
  @Prop({ type: [DocChargeSchema], default: undefined })
  charges?: DocCharge[];

  /** ChargeTotalAmount. */
  @Prop({ min: 0 })
  chargeTotal?: number;

  /** PayableAmount (ValTot del CUFE): incluye domicilio, bolsas y propina. */
  @Prop({ min: 0 })
  payableAmount?: number;

  /** '1' producción, '2' habilitación: el ambiente con el que se calculó el CUFE/CUDE. */
  @Prop()
  tipoAmbiente?: string;

  /** Algo que revisar sin bloquear la emisión (p. ej. domicilio viejo sin INC). */
  @Prop()
  aviso?: string;

  @Prop({ default: 0, min: 0 })
  discountTotal!: number;

  /** Total del documento. Desde la Fase 2 = `payableAmount`; antes, `sale.total`. */
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

  // ── Documento equivalente POS (Fase 7). Ausentes en los demás tipos ────────
  /**
   * `saleId` de la venta en los documentos `pos` e `invoice` vigentes: llave de
   * la exclusión POS/FEV por venta (`INDICE_EXCLUSION_FISCAL`). La nota de
   * ajuste de anulación (Fase 6) lo quita para liberar la venta.
   */
  @Prop({ type: Types.ObjectId })
  ventaFiscal?: Types.ObjectId;

  @Prop({ type: DocCajaVentaSchema })
  cajaVenta?: DocCajaVenta;

  @Prop({ type: DocFabricanteSchema })
  fabricante?: DocFabricante;

  /** Reparto del pago, una parte por medio (pago mixto, D10). */
  @Prop({ type: [DocPagoSchema], default: undefined })
  pagos?: DocPago[];

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

  // ── Trazabilidad de la transmisión (todos opcionales: los documentos ya
  // existentes no los tienen) ────────────────────────────────────────────────
  /** Identificador del envío asíncrono (set de pruebas / GetStatusZip). */
  @Prop()
  trackId?: string;

  @Prop()
  zipKey?: string;

  /** Última respuesta de la DIAN o del adaptador. Nunca guarda secretos. */
  @Prop({ type: Object })
  respuestaDian?: Record<string, unknown>;

  /** Ruta privada del XML firmado (se entrega por URL firmada). */
  @Prop()
  xmlPath?: string;

  @Prop()
  pdfPath?: string;

  /** Ruta del AttachedDocument (ZIP con XML + PDF) que se entrega al cliente. */
  @Prop()
  attachedPath?: string;

  /**
   * Estado de la entrega al adquiriente (Fase 5B): `completa` (PDF + ZIP),
   * `incompleta` (solo PDF, con `motivo`) o `fallida` (nombre del error). Nunca
   * afecta `dianStatus`. Ver `EntregaDianService`.
   */
  @Prop({ type: Object })
  entregaDian?: Record<string, unknown>;

  /** Motivo del rechazo, solo si la DIAN respondió IsValid=false. */
  @Prop()
  rechazoMotivo?: string;

  @Prop({ default: 0, min: 0 })
  intentos?: number;

  @Prop()
  enviadoAt?: Date;

  /**
   * Bloqueo de la transmisión en curso (Fase 4B): id aleatorio de quien lo
   * tomó. Solo el dueño del bloqueo puede mover el estado; así dos llamadas
   * concurrentes no firman ni transmiten dos veces. Ver
   * `TransmisionDianService`.
   */
  @Prop({ type: String })
  bloqueoTransmision?: string;

  /**
   * Por qué el último intento no salió a la red (gate de ambiente, stub,
   * certificado). Aparte de `respuestaDian`, que es solo lo que dijo la red.
   */
  @Prop({ type: Object })
  ultimoIntentoSinRed?: Record<string, unknown>;

  /** Vence el bloqueo: pasado este instante otro intento lo puede tomar. */
  @Prop({ type: Date })
  bloqueoHasta?: Date;

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

// Exclusión POS/FEV (D1, Fase 7): una venta tiene POS o FEV, nunca los dos.
// Las facturas anteriores a la Fase 7 no tienen `ventaFiscal`: para ellas la
// exclusión la hace el servicio antes de emitir (ver `documentoFiscalDeVenta`).
ElectronicDocumentSchema.index(
  { ...INDICE_EXCLUSION_FISCAL.keys },
  {
    ...INDICE_EXCLUSION_FISCAL.options,
    partialFilterExpression: { ...INDICE_EXCLUSION_FISCAL.options.partialFilterExpression },
  },
);

// Único (checklist 1, Fase 1): un solo documento por (emisor, prefijo, número).
// Si una empresa ya tiene duplicados Mongo no lo crea al arrancar; el informe
// `2026-10-consecutivo-duplicado-informe.ts` los lista antes. Ver
// `domain/consecutivo-unico.ts` (el emisor es hoy el NIT; pasará a `emisorId`).
// Si no se pudo crear, `TenantModelRegistry` deja un warn al arrancar.
ElectronicDocumentSchema.index(
  { ...INDICE_CONSECUTIVO_UNICO.keys },
  {
    ...INDICE_CONSECUTIVO_UNICO.options,
    partialFilterExpression: {
      ...INDICE_CONSECUTIVO_UNICO.options.partialFilterExpression,
    },
  },
);
