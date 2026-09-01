import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  INVOICE_SCAN_STATUSES,
  InvoiceScanStatus,
  LINE_TARGETS,
  LineTarget,
  SCAN_ACTIONS,
  ScanAction,
} from '../../domain/invoice-scan.constants';

export type InvoiceScanDocument = HydratedDocument<InvoiceScan>;

/** Una foto de la factura. Una factura de dos hojas tiene dos páginas. */
@Schema({ _id: false })
export class ScanPage {
  @Prop({ required: true })
  imageUrl!: string;

  /** Ruta en el store, necesaria para borrar el archivo. */
  @Prop({ required: true })
  imagePathname!: string;

  /**
   * Capa de texto del PDF, cuando la traía.
   *
   * Su sola presencia decide el camino de lectura: con texto exacto no hace
   * falta reconocer caracteres con un modelo de visión, que es donde se cuelan
   * los errores en los precios.
   */
  @Prop()
  text?: string;

  /** Respuesta cruda del modelo, tal cual llegó. */
  @Prop({ type: Object })
  raw?: unknown;

  @Prop()
  model?: string;

  @Prop()
  extractedAt?: Date;
}
export const ScanPageSchema = SchemaFactory.createForClass(ScanPage);

/**
 * Datos para crear el producto que la factura trae y el inventario no tiene.
 *
 * Se guardan en la decisión de la línea —y no se inventan al aplicar— porque
 * un SKU generado a la brava queda para siempre en el catálogo: la persona lo
 * revisa antes, con lo que la factura ya dio prellenado.
 */
@Schema({ _id: false })
export class NewProductDraft {
  @Prop({ trim: true, uppercase: true })
  sku?: string;

  @Prop({ trim: true })
  name?: string;

  @Prop({ trim: true })
  unit?: string;

  @Prop({ type: Types.ObjectId, ref: 'ProductCategory' })
  categoryId?: Types.ObjectId;

  @Prop({ min: 0 })
  cost?: number;

  /** Sin precio de venta el producto entra al inventario pero no al POS. */
  @Prop({ min: 0 })
  salePrice?: number;

  @Prop({ trim: true })
  barcode?: string;

  @Prop({ min: 0 })
  minStock?: number;
}
export const NewProductDraftSchema =
  SchemaFactory.createForClass(NewProductDraft);

/** Qué hacer con un renglón de la factura al aplicarla. */
@Schema({ _id: false })
export class LineDecision {
  @Prop({ required: true })
  lineIndex!: number;

  @Prop({ required: true, enum: [...LINE_TARGETS], default: 'inventory' })
  target!: LineTarget;

  /** Producto de inventario con el que se emparejó (si target = inventory). */
  @Prop({ type: Types.ObjectId, ref: 'Product' })
  productId?: Types.ObjectId;

  /** true = al aplicar hay que crear el producto porque no existe. */
  @Prop({ default: false })
  createProduct!: boolean;

  /** Categoría de gasto (si target = expense). */
  @Prop({ type: Types.ObjectId, ref: 'FinanceCategory' })
  categoryId?: Types.ObjectId;

  /** Datos del producto a crear (solo si `createProduct`). */
  @Prop({ type: NewProductDraftSchema })
  newProduct?: NewProductDraft;

  /** Cómo se emparejó: alias | barcode | sku | name | manual | none. */
  @Prop()
  matchedBy?: string;
}
export const LineDecisionSchema = SchemaFactory.createForClass(LineDecision);

/** Entrada del historial de la factura. */
@Schema({ _id: false })
export class ScanHistoryEntry {
  @Prop({ required: true, default: () => new Date() })
  at!: Date;

  @Prop()
  userEmail?: string;

  @Prop({ required: true, enum: [...SCAN_ACTIONS] })
  action!: ScanAction;

  /** Texto legible de qué pasó ("costo unitario: 1.200 → 1.250"). */
  @Prop()
  detail?: string;
}
export const ScanHistoryEntrySchema =
  SchemaFactory.createForClass(ScanHistoryEntry);

/** Lo que se creó al aplicar. Sirve para no repetir pasos si un reintento falla. */
@Schema({ _id: false })
export class AppliedRefs {
  @Prop({ type: Types.ObjectId, ref: 'Supplier' })
  supplierId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'PurchaseOrder' })
  purchaseOrderId?: Types.ObjectId;

  @Prop({ type: [Types.ObjectId], default: [] })
  expenseIds!: Types.ObjectId[];

  @Prop({ type: [Types.ObjectId], default: [] })
  createdProductIds!: Types.ObjectId[];
}
export const AppliedRefsSchema = SchemaFactory.createForClass(AppliedRefs);

/**
 * Una factura de compra escaneada.
 *
 * **Un documento = una factura**, no una foto: varias fotos de la misma factura
 * se agrupan en `pages` (por eso subir tres fotos puede dar dos facturas).
 *
 * El `draft` es el borrador editable: sale del modelo y lo corrige la persona.
 * Nada llega al inventario ni a la contabilidad hasta que alguien aprueba.
 */
@Schema({ timestamps: true, collection: 'invoice_scans' })
export class InvoiceScan {
  @Prop({ type: [ScanPageSchema], default: [] })
  pages!: ScanPage[];

  @Prop({
    required: true,
    enum: [...INVOICE_SCAN_STATUSES],
    default: 'uploaded',
  })
  status!: InvoiceScanStatus;

  /** Borrador normalizado (estructura `ExtractedInvoice`), editable. */
  @Prop({ type: Object })
  draft?: unknown;

  /**
   * NIT y número de factura desnormalizados desde el borrador. Están fuera del
   * `draft` para poder indexarlos: son la clave con la que se agrupan las
   * páginas y con la que se impide cargar dos veces la misma factura.
   */
  @Prop({ trim: true })
  supplierDocNumber?: string;

  @Prop({ trim: true })
  invoiceNumber?: string;

  @Prop({ type: Types.ObjectId, ref: 'Supplier' })
  supplierId?: Types.ObjectId;

  /** matched (por NIT) | manual (lo eligió el usuario) | new (hay que crearlo) | unknown. */
  @Prop({ default: 'unknown' })
  supplierMatch!: string;

  /** Sede a la que entra la mercancía. */
  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  @Prop({ type: [LineDecisionSchema], default: [] })
  lineDecisions!: LineDecision[];

  @Prop({ type: AppliedRefsSchema, default: () => ({}) })
  appliedTo!: AppliedRefs;

  @Prop({ type: [ScanHistoryEntrySchema], default: [] })
  history!: ScanHistoryEntry[];

  /** Último error de extracción, para mostrarlo y poder reintentar. */
  @Prop()
  error?: string;

  @Prop({ required: true })
  createdByEmail!: string;
}

export const InvoiceScanSchema = SchemaFactory.createForClass(InvoiceScan);

// Agrupar páginas y buscar por proveedor exige este índice.
InvoiceScanSchema.index({ supplierDocNumber: 1, invoiceNumber: 1 });

// La misma factura no se puede aplicar dos veces. Índice ÚNICO PARCIAL: solo
// mira las ya aplicadas, así que se pueden tener varios borradores del mismo
// documento mientras se decide, pero solo uno llega al inventario.
InvoiceScanSchema.index(
  { supplierDocNumber: 1, invoiceNumber: 1 },
  {
    unique: true,
    name: 'uniq_applied_invoice',
    partialFilterExpression: {
      status: 'applied',
      supplierDocNumber: { $type: 'string' },
      invoiceNumber: { $type: 'string' },
    },
  },
);

// La lista del módulo ordena por fecha de creación.
InvoiceScanSchema.index({ createdAt: -1 });
