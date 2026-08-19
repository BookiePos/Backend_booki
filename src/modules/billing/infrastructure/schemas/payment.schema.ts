import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { BusinessAddOns } from '../../../control/domain/plans';
import {
  PAYMENT_KINDS,
  PAYMENT_STATUSES,
} from '../../domain/billing.constants';

export type PaymentDocument = HydratedDocument<Payment>;

/**
 * Registro de un pago (transacción Wompi). Vive en el control-plane. La
 * `reference` es única y es la que Wompi devuelve en el webhook para casar el
 * evento con este pago. `applied` da idempotencia a la aplicación de
 * entitlements (activar plan/complementos) ante webhooks repetidos.
 */
@Schema({ timestamps: true, collection: 'billing_payments' })
export class Payment {
  @Prop({ required: true, index: true })
  businessId!: string;

  @Prop({ index: true })
  subscriptionId?: string;

  @Prop({ required: true, unique: true, index: true })
  reference!: string;

  @Prop({ required: true, enum: PAYMENT_KINDS })
  kind!: string;

  @Prop({ required: true })
  amountInCents!: number;

  @Prop({ required: true, enum: PAYMENT_STATUSES, default: 'pending' })
  status!: string;

  @Prop()
  wompiTransactionId?: string;

  /** Snapshot de lo comprado, para aplicarlo al aprobarse el pago. */
  @Prop()
  plan?: string;

  @Prop({ type: Object })
  addOns?: BusinessAddOns;

  @Prop()
  docPackages?: number;

  /** Ya se aplicaron los entitlements de este pago (idempotencia). */
  @Prop({ default: false })
  applied!: boolean;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);
