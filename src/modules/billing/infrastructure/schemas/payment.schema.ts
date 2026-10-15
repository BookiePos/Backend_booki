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

  /**
   * Ya se aplicaron TODOS los entitlements de este pago (idempotencia). Se
   * marca al terminar los efectos, no antes: si uno falla, el pago queda
   * aprobado sin `applied` y el barrido lo retoma.
   */
  @Prop({ default: false })
  applied!: boolean;

  /**
   * Reserva de la aplicación en curso (quién y desde cuándo). Caduca a los
   * `APPLY_LEASE_MS` para que un proceso muerto a mitad no la deje tomada.
   */
  @Prop({ type: Date, default: null })
  applyingAt?: Date | null;

  /**
   * Pasos de la aplicación ya hechos (`docCredits`, `plan`, `period`). Al
   * retomar un pago a medias se saltan: acreditar documentos o avanzar el
   * período no son idempotentes por sí solos.
   */
  @Prop({ type: [String], default: [] })
  effectsDone!: string[];

  /** Versión del protocolo con que se reservó la aplicación (`APPLY_VERSION`). */
  @Prop()
  applyVersion?: number;

  /** Última vez que el barrido consultó este pago a la pasarela. */
  @Prop({ type: Date, default: null })
  lastReconcileAt?: Date | null;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);
