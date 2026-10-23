import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  DISCOUNT_TYPES,
  DiscountType,
  PAYMENT_METHODS,
  PaymentMethod,
  SALE_STATUSES,
  SaleStatus,
} from '../../domain/sales.constants';
import {
  DELIVERY_STATUSES,
  DeliveryStatus,
  ORDER_TYPES,
  OrderType,
} from '../../../delivery/domain/delivery.constants';
import {
  SALE_TAX_KINDS,
  SaleTaxKind,
} from '../../../core-tax/domain/sale-tax';

import { PLATFORM_CODES, PlatformCode } from '../../domain/platform-orders';

export type SaleDocument = HydratedDocument<Sale>;

/** Porción de lote consumida por una línea (costo de venta / trazabilidad). */
@Schema({ _id: false })
class SaleConsumedLot {
  @Prop({ type: Types.ObjectId, ref: 'StockLot' })
  lotId?: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  qty!: number;

  @Prop({ default: 0, min: 0 })
  unitCost!: number;
}
const SaleConsumedLotSchema = SchemaFactory.createForClass(SaleConsumedLot);

/** Línea de venta: snapshot del producto vendible del catálogo (POS). */
@Schema({ _id: false })
class SaleLine {
  /** Producto de catálogo vendido (lo que ve el cliente en el recibo). */
  @Prop({ type: Types.ObjectId, ref: 'CatalogProduct', required: true })
  productId!: Types.ObjectId;

  @Prop({ required: true })
  sku!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  unit!: string;

  @Prop({ required: true, min: 0 })
  qty!: number;

  /** Precio unitario al momento de la venta (siempre del servidor). */
  @Prop({ required: true, min: 0 })
  unitPrice!: number;

  /** Bruto de la línea: qty × unitPrice, antes de descuento. */
  @Prop({ required: true, min: 0 })
  lineTotal!: number;

  /** Descuento aplicado a esta línea (0 si ninguno). Neto = lineTotal − esto. */
  @Prop({ default: 0, min: 0 })
  discountAmount!: number;

  /** Nombre del descuento aplicado (snapshot para el recibo). */
  @Prop({ trim: true })
  discountName?: string;

  /**
   * Tarifa de IVA aplicada a la línea (0/5/19). El precio ya la incluye.
   * En una línea con INC es 0: el INC no es IVA (ver `taxKind`/`taxRate`).
   */
  @Prop({ default: 0, min: 0 })
  ivaRate!: number;

  /**
   * Qué impuesto lleva `taxAmount`: IVA (2408), INC de restaurante (2495) o
   * ninguno (no responsable). Las ventas anteriores a este campo eran IVA.
   */
  @Prop({ enum: SALE_TAX_KINDS, default: 'iva' })
  taxKind!: SaleTaxKind;

  /** Tarifa del impuesto de la línea, sea IVA o INC (19, 8, 0…). */
  @Prop({ default: 0, min: 0 })
  taxRate!: number;

  /** Base gravable de la línea (neto sin impuesto), para la factura electrónica. */
  @Prop({ default: 0, min: 0 })
  taxBase!: number;

  /** Impuesto de la línea (IVA o INC, incluido en el precio). */
  @Prop({ default: 0, min: 0 })
  taxAmount!: number;

  /** Vestigial: la trazabilidad de lotes vive ahora en `components`. */
  @Prop({ type: [SaleConsumedLotSchema], default: [] })
  consumedLots!: SaleConsumedLot[];
}
const SaleLineSchema = SchemaFactory.createForClass(SaleLine);

/**
 * Consumo de inventario que generó la venta (ítem directo o ingredientes de
 * las recetas, agregado por ítem). Guarda el costo real (FEFO) para el COGS.
 */
@Schema({ _id: false })
class SaleComponent {
  /** Ítem de inventario descontado. */
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ required: true })
  sku!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  unit!: string;

  /** Cantidad total descontada del inventario. */
  @Prop({ required: true, min: 0 })
  qty!: number;

  /** Costo real de lo consumido (Σ qty × unitCost de los lotes). */
  @Prop({ default: 0, min: 0 })
  cost!: number;

  @Prop({ type: [SaleConsumedLotSchema], default: [] })
  consumedLots!: SaleConsumedLot[];
}
const SaleComponentSchema = SchemaFactory.createForClass(SaleComponent);

/**
 * Empaque con el que salió la venta: la bolsa, el vaso, la caja.
 *
 * Es un duplicado a propósito de lo que ya está dentro de `components` —ahí va
 * mezclado con la harina y el azúcar, sin forma de volver a distinguirlo— y el
 * costo NO se cuenta dos veces: el del COGS sigue siendo el de `components`.
 * Esto es la memoria de la decisión, y es lo único que permite contestar "¿con
 * qué suele salir esto?" la próxima vez que se venda lo mismo.
 */
@Schema({ _id: false })
class SalePackaging {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true, min: 0 })
  qty!: number;
}
const SalePackagingSchema = SchemaFactory.createForClass(SalePackaging);

/** Descuento aplicado a la venta (descriptor + monto resuelto). */
@Schema({ _id: false })
class SaleDiscount {
  @Prop({ required: true, enum: DISCOUNT_TYPES })
  type!: DiscountType;

  /** Valor pedido: pesos (amount) o porcentaje (percent). */
  @Prop({ required: true, min: 0 })
  value!: number;

  /** Monto de descuento efectivamente aplicado (en pesos). */
  @Prop({ required: true, min: 0 })
  amount!: number;
}
const SaleDiscountSchema = SchemaFactory.createForClass(SaleDiscount);

@Schema({ _id: false })
class SalePayment {
  @Prop({ required: true, enum: PAYMENT_METHODS })
  method!: PaymentMethod;

  /** Monto recibido (efectivo). */
  @Prop({ min: 0 })
  received?: number;

  @Prop({ min: 0 })
  change?: number;
}
const SalePaymentSchema = SchemaFactory.createForClass(SalePayment);

/**
 * Una parte de un cobro mixto (ítem 6.9): cuánto cubrió cada medio. Monto NETO:
 * el efectivo ya sin el vuelto, así que la suma es exactamente lo cobrado.
 */
@Schema({ _id: false })
class SalePaymentPart {
  @Prop({ required: true, enum: PAYMENT_METHODS })
  method!: PaymentMethod;

  @Prop({ required: true, min: 0 })
  amount!: number;
}
const SalePaymentPartSchema = SchemaFactory.createForClass(SalePaymentPart);

/** Datos del cliente para la factura (todos opcionales). */
@Schema({ _id: false })
class SaleCustomer {
  @Prop({ trim: true })
  name?: string;

  /** Cédula / NIT del cliente. */
  @Prop({ trim: true })
  idNumber?: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ trim: true })
  email?: string;
}
const SaleCustomerSchema = SchemaFactory.createForClass(SaleCustomer);

/**
 * Quién vendió, copiado al momento de la venta.
 *
 * Se guarda el nombre y no solo el id porque el empleado se puede ir o cambiar
 * de nombre en la ficha, y la venta tiene que seguir diciendo quién la hizo.
 */
@Schema({ _id: false })
class SaleSeller {
  @Prop({ type: Types.ObjectId, ref: 'Employee' })
  employeeId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;
}
const SaleSellerSchema = SchemaFactory.createForClass(SaleSeller);

/**
 * Entrega a domicilio: a dónde va el pedido y cuánto costó llevarlo.
 *
 * El nombre de la zona y la tarifa se copian a propósito. La zona se puede
 * renombrar o cambiar de precio mañana, y la venta tiene que seguir diciendo
 * lo que se cobró ese día.
 */
@Schema({ _id: false })
export class SaleDelivery {
  @Prop({ type: Types.ObjectId, ref: 'DeliveryZone' })
  zoneId?: Types.ObjectId;

  @Prop({ trim: true })
  zoneName?: string;

  @Prop({ required: true, trim: true })
  address!: string;

  @Prop({ trim: true })
  phone?: string;

  /** "Apartamento 302, timbre dañado, llamar al llegar." */
  @Prop({ trim: true })
  notes?: string;

  /** Quién lo llevó. Texto libre: casi siempre es un nombre de pila. */
  @Prop({ trim: true })
  courier?: string;

  /**
   * En qué va la entrega. Es logística, no dinero: la venta ya ocurrió y la
   * plata ya entró. Un domicilio que se cae se resuelve con una devolución, no
   * cambiándole el estado a la venta.
   */
  @Prop({ required: true, enum: DELIVERY_STATUSES, default: 'pendiente' })
  status!: DeliveryStatus;

  /** Cuándo salió con el repartidor. */
  @Prop()
  dispatchedAt?: Date;

  /** Cuándo llegó. De aquí sale cuánto se demoró de verdad cada entrega. */
  @Prop()
  deliveredAt?: Date;

  /** Por qué no se pudo entregar. Obligatorio al marcar fallido. */
  @Prop({ trim: true })
  failureReason?: string;
}
const SaleDeliverySchema = SchemaFactory.createForClass(SaleDelivery);

/**
 * Pedido de una plataforma de domicilio (ítem 7.5). El par (`code`,
 * `externalId`) identifica el pedido en el portal: es la llave de idempotencia
 * para que importar dos veces el mismo CSV no duplique ventas.
 */
@Schema({ _id: false })
class SalePlatform {
  @Prop({ required: true, enum: PLATFORM_CODES })
  code!: PlatformCode;

  /** Código del pedido en la plataforma. */
  @Prop({ required: true, trim: true, maxlength: 80 })
  externalId!: string;

  /** Fecha del pedido según el portal (YYYY-MM-DD). El asiento lleva esa fecha si es del mes en curso (ver accountingDate). */
  @Prop()
  orderedAt?: string;

  /** Fecha contable del asiento de la venta (YYYY-MM-DD); base del orden de las liquidaciones. */
  @Prop()
  accountingDate?: string;

  /** Comisión que el portal informó; la real se reconoce al liquidar. */
  @Prop({ min: 0 })
  commissionEstimate?: number;

  /** Liquidación que cobró este pedido. Sin ella, la plataforma todavía lo debe. */
  @Prop({ type: Types.ObjectId })
  settlementId?: Types.ObjectId;
}
const SalePlatformSchema = SchemaFactory.createForClass(SalePlatform);

/** Venta del POS. Documento único y atómico (Mongo standalone). */
@Schema({ timestamps: true, collection: 'sales' })
export class Sale {
  /** Consecutivo por sede, ej. "FV-000123". */
  @Prop({ required: true, trim: true })
  saleNumber!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true })
  cashierId!: string;

  @Prop({ required: true })
  cashierEmail!: string;

  /** Nombre del cajero al momento de la venta (encabezado de factura). */
  @Prop({ trim: true })
  cashierName?: string;

  /**
   * Quién vendió, si no fue quien cobró. Vacío en las ventas viejas y cuando
   * el mismo cajero atendió: en ese caso el vendedor es `cashierName`.
   */
  @Prop({ type: SaleSellerSchema })
  seller?: SaleSeller;

  @Prop({ required: true, enum: SALE_STATUSES, default: 'completed' })
  status!: SaleStatus;

  @Prop({ type: [SaleLineSchema], required: true })
  lines!: SaleLine[];

  /** Salidas de inventario que originó la venta (para stock y costo). */
  @Prop({ type: [SaleComponentSchema], default: [] })
  components!: SaleComponent[];

  /**
   * Con qué empaque salió. Vacío en las ventas anteriores a esta versión y en
   * las que salieron sin empaque, que son cosas distintas pero se parecen: por
   * eso la sugerencia solo aprende de ventas con `packagingExplicit`.
   */
  @Prop({ type: [SalePackagingSchema], default: [] })
  packaging!: SalePackaging[];

  /**
   * Quien cobró decidió el empaque a mano en esta venta (aunque fuera para
   * dejarla sin ninguno). Distingue "salió sin empaque" de "esta venta es de
   * antes de que se pudiera elegir", que es justo lo que no se puede deducir
   * de una lista vacía.
   */
  @Prop({ default: false })
  packagingExplicit!: boolean;

  @Prop({ required: true, min: 0 })
  subtotal!: number;

  /** Descuento aplicado (opcional). */
  @Prop({ type: SaleDiscountSchema })
  discount?: SaleDiscount;

  /** Monto total de descuento (0 si no hubo). */
  @Prop({ default: 0, min: 0 })
  discountTotal!: number;

  /** Base gravable total (Σ bases de línea sin IVA). */
  @Prop({ default: 0, min: 0 })
  taxableBase!: number;

  /** Impuesto total, IVA + INC (incluido en los precios). El desglose va por línea (`taxKind`). */
  @Prop({ default: 0, min: 0 })
  taxTotal!: number;

  @Prop({ required: true, min: 0 })
  total!: number;

  /**
   * Propina (voluntaria, restaurante). NO es venta ni base gravable: se cobra
   * encima del total y se entrega al personal. El monto a pagar = total + tip.
   */
  @Prop({ default: 0, min: 0 })
  tip!: number;

  /** Cómo salió el pedido: mostrador, mesa, para llevar o domicilio. */
  @Prop({ required: true, enum: ORDER_TYPES, default: 'mostrador' })
  orderType!: OrderType;

  /**
   * Cobro del domicilio. Se cobra ENCIMA del total y NO entra a la base
   * gravable —decisión tomada con el dueño— así que va en su propio campo y no
   * como una línea más. El monto a pagar = total + tip + deliveryFee.
   *
   * A diferencia de la propina, sí es ingreso del negocio y por eso sí va al
   * libro contable.
   */
  @Prop({ default: 0, min: 0 })
  deliveryFee!: number;

  /** A dónde se lleva y quién lo lleva. Solo en `orderType: 'domicilio'`. */
  @Prop({ type: SaleDeliverySchema })
  delivery?: SaleDelivery;

  /**
   * Medio de pago. En un cobro mixto es el medio que más cubrió (lo que leen
   * los módulos que solo conocen un medio, como la factura electrónica), y
   * `received`/`change` son el efectivo entregado y su vuelto.
   */
  @Prop({ type: SalePaymentSchema, required: true })
  payment!: SalePayment;

  /**
   * Reparto del cobro mixto, una parte por medio. Vacío en las ventas de un
   * solo medio (y en las de antes del ítem 6.9): ahí `payment.method` cubrió
   * todo. Léelo con `salePartsOf` (domain/sale-payments.ts), no a mano.
   */
  @Prop({ type: [SalePaymentPartSchema], default: undefined })
  payments?: SalePaymentPart[];

  /** Datos del cliente para la factura (opcional). */
  @Prop({ type: SaleCustomerSchema })
  customer?: SaleCustomer;

  /** Turno de caja; se llenará cuando exista el módulo de Caja. */
  @Prop({ type: Types.ObjectId })
  cajaSessionId?: Types.ObjectId;

  /** Cuenta abierta que originó la venta (si se liquidó una cuenta). */
  @Prop({ type: Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;

  /**
   * Venta cobrada sin internet y registrada al sincronizar (ítem 6.3): el UUID
   * que le puso el terminal. Único: reenviar la misma venta no la duplica.
   */
  @Prop({ type: String })
  offlineId?: string;

  /**
   * Cuándo se cobró de verdad, si fue offline. `createdAt` es cuándo llegó al
   * servidor; el asiento usa esta fecha.
   */
  @Prop()
  soldAt?: Date;

  /**
   * Venta offline cuyo turno de reserva ya estaba cerrado y entró al abierto a
   * pedido: el turno donde de verdad se contó el efectivo.
   */
  @Prop({ type: Types.ObjectId })
  offlineTurnoOrigenId?: Types.ObjectId;

  /**
   * Venta offline registrada «con lo cobrado» por quien autoriza anulaciones
   * (TOTAL_DISTINTO, SIN_STOCK, PRODUCTO_INACTIVO). `faltantes` es lo que se
   * vendió sin estar en el inventario registrado: hay que regularizarlo con
   * un ajuste (su costo no entró al asiento de la venta).
   */
  @Prop({
    type: {
      byUserId: { type: String, required: true },
      byEmail: { type: String },
      at: { type: Date, required: true },
      faltantes: [{ productId: { type: Types.ObjectId }, qty: { type: Number } }],
    },
    _id: false,
  })
  offlineOverride?: {
    byUserId: string;
    byEmail?: string;
    at: Date;
    faltantes: { productId: Types.ObjectId; qty: number }[];
  };

  /**
   * Si el pedido vino de una plataforma de domicilio. Con él, `payment.method`
   * es `platform`: el cobro es una cuenta por cobrar a la plataforma.
   */
  @Prop({ type: SalePlatformSchema })
  platform?: SalePlatform;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);

SaleSchema.index({ sedeId: 1, saleNumber: 1 }, { unique: true });
SaleSchema.index({ sedeId: 1, createdAt: -1 });
SaleSchema.index(
  { offlineId: 1 },
  { unique: true, partialFilterExpression: { offlineId: { $type: 'string' } } },
);

// Un pedido de plataforma vive una sola vez: (plataforma, código externo) único
// entre las ventas completadas. Una venta anulada libera el código para
// registrarlo de nuevo. Es el respaldo de la verificación previa del servicio.
SaleSchema.index(
  { 'platform.code': 1, 'platform.externalId': 1 },
  {
    unique: true,
    name: 'pedido_plataforma_unico',
    partialFilterExpression: { 'platform.externalId': { $type: 'string' }, status: 'completed' },
  },
);
// Saldo por cobrar a cada plataforma: pedidos de la sede sin liquidar.
SaleSchema.index(
  { sedeId: 1, 'platform.code': 1, 'platform.settlementId': 1, createdAt: -1 },
  { partialFilterExpression: { 'platform.code': { $exists: true } } },
);
