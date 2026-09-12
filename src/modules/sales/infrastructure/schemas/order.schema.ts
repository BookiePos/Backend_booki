import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ORDER_STATUSES, OrderStatus } from '../../domain/order.constants';

export type OrderDocument = HydratedDocument<Order>;

/** Línea de una cuenta abierta: snapshot del producto vendible del catálogo. */
@Schema({ _id: false })
class OrderLine {
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

  /** Precio unitario al momento de agregar (referencial; el cobro recalcula). */
  @Prop({ required: true, min: 0 })
  unitPrice!: number;

  @Prop({ required: true, min: 0 })
  lineTotal!: number;

  /**
   * Cuánto de esta línea ya se cobró.
   *
   * Es lo que permite dividir la cuenta: cada cobro paga un subconjunto y la
   * comanda sigue abierta hasta que no quede nada. En una comanda que se paga
   * entera vale 0 hasta el cobro y `qty` después, así que las que ya existen
   * siguen comportándose igual.
   */
  @Prop({ default: 0, min: 0 })
  paidQty!: number;
}
const OrderLineSchema = SchemaFactory.createForClass(OrderLine);

/**
 * Cuenta abierta (comanda / mesa). Se sostiene con un número consecutivo y se
 * le agregan ítems antes de liquidarla. El inventario NO se toca mientras está
 * abierta: se descuenta al cobrar (checkout crea la Sale).
 */
@Schema({ timestamps: true, collection: 'orders' })
export class Order {
  /** Consecutivo por sede, ej. "CENTRO-C-000012". */
  @Prop({ required: true, trim: true })
  orderNumber!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true, enum: ORDER_STATUSES, default: 'open' })
  status!: OrderStatus;

  /** Etiqueta libre: mesa, nombre del cliente, etc. */
  @Prop({ trim: true })
  label?: string;

  @Prop({ trim: true })
  note?: string;

  @Prop({ type: [OrderLineSchema], default: [] })
  lines!: OrderLine[];

  @Prop({ required: true })
  openedById!: string;

  @Prop({ required: true })
  openedByEmail!: string;

  /**
   * Última venta generada al liquidar. Se conserva porque ya lo leen las
   * pantallas; con la cuenta dividida hay varias y están todas en `saleIds`.
   */
  @Prop({ type: Types.ObjectId, ref: 'Sale' })
  saleId?: Types.ObjectId;

  /** Todas las ventas de esta comanda, en el orden en que se cobraron. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Sale' }], default: [] })
  saleIds!: Types.ObjectId[];

  /**
   * Contador de cobros, para el bloqueo optimista.
   *
   * Dos meseros cobrando partes distintas de la misma mesa al mismo tiempo
   * leerían las mismas cantidades pendientes y las cobrarían dos veces. Cada
   * cobro exige que el contador siga siendo el que leyó; el segundo pierde y
   * vuelve a intentar con los datos frescos.
   */
  @Prop({ default: 0, min: 0 })
  paymentSeq!: number;

  /** Comanda de restaurante que originó esta cuenta (puente restaurante → POS). */
  @Prop({ type: Types.ObjectId, ref: 'RestaurantOrder' })
  restaurantOrderId?: Types.ObjectId;

  @Prop({ type: Date })
  closedAt?: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ sedeId: 1, status: 1, updatedAt: -1 });
OrderSchema.index({ sedeId: 1, orderNumber: 1 }, { unique: true });
