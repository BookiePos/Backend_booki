import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { BusinessAddOns } from '../../../control/domain/plans';
import {
  BILLING_CYCLES,
  SUBSCRIPTION_STATUSES,
} from '../../domain/billing.constants';

export type SubscriptionDocument = HydratedDocument<Subscription>;

/**
 * Suscripción recurrente de una empresa. Vive en el control-plane
 * (`bookipos_control`), una por empresa. Guarda el `paymentSourceId` de Wompi
 * (tarjeta tokenizada) contra el que el cron cobra cada período.
 */
@Schema({ timestamps: true, collection: 'subscriptions' })
export class Subscription {
  @Prop({ required: true, unique: true, index: true })
  businessId!: string;

  @Prop({ required: true })
  plan!: string;

  @Prop({ required: true, enum: BILLING_CYCLES, default: 'monthly' })
  billingCycle!: string;

  /** Complementos recurrentes (nómina, sedes extra, empleados extra). */
  @Prop({ type: Object, default: {} })
  addOns?: BusinessAddOns;

  /** Id de la fuente de pago (tarjeta tokenizada) en Wompi. */
  @Prop({ required: true })
  paymentSourceId!: number;

  @Prop({ required: true })
  customerEmail!: string;

  /** Monto recurrente en centavos (plan + complementos prorrateados al ciclo). */
  @Prop({ required: true })
  amountInCents!: number;

  @Prop({ required: true, enum: SUBSCRIPTION_STATUSES, default: 'pending' })
  status!: string;

  /** Fin del período pagado (hasta cuándo está al día). */
  @Prop()
  currentPeriodEnd?: Date;

  /** Cuándo cobrar la próxima renovación. */
  @Prop()
  nextChargeAt?: Date;

  /** Último intento de cobro (para el cooldown de reintentos). */
  @Prop()
  lastChargeAttemptAt?: Date;

  @Prop()
  lastTransactionId?: string;

  @Prop({ default: 0 })
  failedAttempts!: number;

  @Prop()
  canceledAt?: Date;
}

export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);
