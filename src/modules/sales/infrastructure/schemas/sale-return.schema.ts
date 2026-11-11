import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  REFUND_METHODS,
  RESTOCK_MODES,
  RETURN_REASONS,
  RefundMethod,
  RestockMode,
  ReturnReason,
} from '../../domain/sale-return';

/** Una línea devuelta, con lo que se le reembolsó por ella. */
@Schema({ _id: false })
export class SaleReturnLine {
  @Prop({ type: Types.ObjectId, ref: 'CatalogProduct', required: true })
  productId!: Types.ObjectId;

  /** Snapshot legible: el catálogo puede cambiar después. */
  @Prop({ required: true })
  sku!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true, min: 0 })
  qty!: number;

  /** Lo que se le devolvió por esta línea, con IVA incluido. */
  @Prop({ required: true, min: 0 })
  refund!: number;

  /** Parte de ese reembolso que es IVA. */
  @Prop({ default: 0, min: 0 })
  refundTax!: number;
}

const SaleReturnLineSchema = SchemaFactory.createForClass(SaleReturnLine);

/**
 * Lo que volvió de cada ítem de inventario y el costo de venta que deshizo
 * (0 si se fue a merma). Las devoluciones siguientes lo suman para repartir
 * el costo con redondeo acumulado y para no devolver al inventario más de lo
 * que la venta consumió (ítem 1.16). Vacío en las devoluciones anteriores.
 */
@Schema({ _id: false })
export class SaleReturnComponent {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  qty!: number;

  @Prop({ default: 0, min: 0 })
  cogs!: number;
}

const SaleReturnComponentSchema = SchemaFactory.createForClass(SaleReturnComponent);

export type SaleReturnDocument = HydratedDocument<SaleReturn>;

/**
 * Devolución parcial de una venta.
 *
 * Es un documento aparte y no un cambio sobre la venta: la venta ya ocurrió y
 * es un hecho, igual que un asiento del libro. Lo que vuelve se registra
 * encima, con su fecha, su motivo y quién lo autorizó. Así una venta puede
 * tener varias devoluciones y el historial no se pisa.
 */
@Schema({ timestamps: true, collection: 'sale_returns' })
export class SaleReturn {
  @Prop({ type: Types.ObjectId, ref: 'Sale', required: true, index: true })
  saleId!: Types.ObjectId;

  /** Número de la venta, copiado para poder buscar sin cruzar colecciones. */
  @Prop({ required: true, trim: true })
  saleNumber!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: [SaleReturnLineSchema], required: true })
  lines!: SaleReturnLine[];

  @Prop({ type: [SaleReturnComponentSchema], default: [] })
  components!: SaleReturnComponent[];

  /**
   * Devolución (vuelve mercancía) o rebaja posterior (Fase 6C: se reconoce un
   * menor valor sin que vuelva nada). Sin el campo es una devolución. La
   * rebaja lleva sus líneas con `qty` 0, sin componentes ni destino, y
   * comparte con la devolución los pasos (cartera, nota, caja y libro), el
   * turno, la idempotencia y el bloqueo de la anulación.
   */
  @Prop({ type: String, enum: ['devolucion', 'rebaja'] })
  kind?: 'devolucion' | 'rebaja';

  /** Concepto de la nota de la rebaja (3, 4, 5 o 6). Solo en la rebaja. */
  @Prop({ type: String, enum: ['3', '4', '5', '6'] })
  concepto?: '3' | '4' | '5' | '6';

  @Prop({
    type: String,
    enum: RETURN_REASONS,
    required(this: { kind?: string }) {
      return this.kind !== 'rebaja';
    },
  })
  reason!: ReturnReason;

  /**
   * Qué se hizo con la mercancía. `inventory` la devuelve al estante;
   * `waste` la registra como merma, porque volvió pero ya no se puede vender.
   */
  @Prop({
    type: String,
    enum: RESTOCK_MODES,
    required(this: { kind?: string }) {
      return this.kind !== 'rebaja';
    },
  })
  restock!: RestockMode;

  /**
   * Si la merma alcanzó a registrarse. Solo importa cuando `restock` es
   * `waste`: la mercancía vuelve al inventario y se da de baja en un segundo
   * paso, y si ese paso falla queda existencia de más, visible y corregible.
   */
  @Prop({ default: false })
  wasteRecorded!: boolean;

  @Prop({ required: true, enum: REFUND_METHODS })
  refundMethod!: RefundMethod;

  /** Lo que se le devolvió al cliente en total, con IVA. */
  @Prop({ required: true, min: 0 })
  refundTotal!: number;

  /** IVA contenido en ese reembolso (para reversarlo en el libro). */
  @Prop({ default: 0, min: 0 })
  refundTax!: number;

  /**
   * Propina devuelta, APARTE de `refundTotal` (decisión 4 del dueño): en
   * proporción a lo devuelto, con redondeo acumulado. Sale de la 2380 y se
   * devuelve por el mismo medio que el resto.
   */
  @Prop({ default: 0, min: 0 })
  tipRefund!: number;

  @Prop({ trim: true })
  note?: string;

  /**
   * Llave idempotente del cliente (Fase 6B): reintentar la misma devolución
   * devuelve este registro y su nota, no otra devolución.
   */
  @Prop({ trim: true })
  idempotencyKey?: string;

  /**
   * Cliente efectivo de la devolución (el de la venta o el indicado al
   * registrarla): a quien se le abona el saldo a favor. Se guarda para que
   * completar una devolución a medias no dependa de volver a enviarlo.
   */
  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  /**
   * Pasos de la devolución (D1). Nace `en_curso` y pasa a `completa` cuando
   * stock, caja y libro quedaron. `pendiente_caja` (N6): solo falta la salida
   * de efectivo, que el barrido no anota; la completa el cajero con
   * `POST /sales/returns/:id/completar`. Las devoluciones de antes no lo tienen: se
   * tratan como completas y un reintento no las vuelve a mover.
   */
  @Prop({ type: String, enum: ['en_curso', 'pendiente_caja', 'completa'] })
  estado?: 'en_curso' | 'pendiente_caja' | 'completa';

  /**
   * Turno de quien la está completando (N1): mientras no venza, otra petición
   * con la misma llave responde 409 en vez de mover stock y caja otra vez.
   */
  @Prop({ type: Date, default: null })
  procesandoHasta?: Date | null;

  /** La cartera del fiado y la nota fiscal ya quedaron. */
  @Prop()
  carteraHecha?: boolean;

  /** La mercancía volvió al inventario (y la merma, si aplica, se intentó). */
  @Prop()
  stockHecho?: boolean;

  /** La salida de efectivo quedó en la caja (o no había efectivo que sacar). */
  @Prop()
  cajaHecha?: boolean;

  /** El asiento de la devolución quedó en el libro. */
  @Prop()
  asientoHecho?: boolean;

  /**
   * Parte del reembolso que bajó la cuenta por cobrar de la venta fiada en vez
   * de devolverse en plata (Cr 1305 en el asiento).
   */
  @Prop({ default: 0, min: 0 })
  abonoCartera!: number;

  /**
   * Parte de lo reconocido que vuelve al saldo a favor del cliente porque la
   * venta se pagó con `saldo_favor` (Fase 6C): Cr 2805, nunca efectivo.
   */
  @Prop({ default: 0, min: 0 })
  aSaldoFavor!: number;

  /** Nota crédito / de ajuste de la devolución, o por qué no la lleva (`NotaFiscalOperacion`). */
  @Prop({ type: Object })
  notaFiscal?: Record<string, unknown>;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true, trim: true })
  userEmail!: string;
}

export const SaleReturnSchema = SchemaFactory.createForClass(SaleReturn);

SaleReturnSchema.index({ sedeId: 1, createdAt: -1 });
// Barrido de devoluciones varadas (N2): solo las `en_curso`, por antigüedad.
SaleReturnSchema.index({ estado: 1, createdAt: 1 }, { partialFilterExpression: { estado: 'en_curso' } });

// Una devolución por llave del cliente: el reintento no devuelve dos veces.
SaleReturnSchema.index(
  { saleId: 1, idempotencyKey: 1 },
  { name: 'devolucion_idempotente', unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
