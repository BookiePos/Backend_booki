import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PaymentMethodDocument = HydratedDocument<PaymentMethod>;

/**
 * Tarjeta registrada de una empresa (una por empresa), en el control-plane.
 *
 * Vive aparte de `Subscription` a propósito: el dueño registra la tarjeta ANTES
 * de contratar, y antes de contratar no hay plan ni monto que poner en una
 * suscripción. Mientras la tarjeta se guardaba solo dentro de la suscripción,
 * quien la registraba sin suscribirse no la tenía guardada en ningún lado: al
 * recargar la página desaparecía y había que volver a escribirla.
 *
 * Guarda el `paymentSourceId` de Wompi (contra el que se cobra) y los datos
 * públicos de la tarjeta para poder mostrarla. El número completo no pasa por
 * aquí: lo captura el widget de Wompi y solo nos devuelve un token de un uso.
 */
@Schema({ timestamps: true, collection: 'billing_payment_methods' })
export class PaymentMethod {
  @Prop({ required: true, unique: true, index: true })
  businessId!: string;

  /** Id de la fuente de pago (tarjeta tokenizada) en Wompi. */
  @Prop({ required: true })
  paymentSourceId!: number;

  /** Correo con el que se creó la fuente de pago en Wompi. */
  @Prop({ required: true })
  customerEmail!: string;

  /** Marca de la tarjeta (VISA, MASTERCARD…), dato público de Wompi. */
  @Prop({ type: String, default: null })
  brand?: string | null;

  /** Últimos cuatro dígitos, dato público de Wompi. */
  @Prop({ type: String, default: null })
  lastFour?: string | null;
}

export const PaymentMethodSchema = SchemaFactory.createForClass(PaymentMethod);
