import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  RECEIVABLE_STATUSES,
  ReceivableStatus,
  PAYMENT_METHODS,
  FinancePaymentMethod,
} from '../../domain/finance.constants';

export type FinanceReceivableDocument = HydratedDocument<FinanceReceivable>;

/** Abono a una cuenta por cobrar (embebido). */
@Schema({ _id: false })
export class ReceivablePayment {
  /** Fecha del abono YYYY-MM-DD. */
  @Prop({ required: true, trim: true })
  date!: string;

  @Prop({ required: true, min: 0 })
  amount!: number;

  @Prop({ enum: PAYMENT_METHODS })
  method?: FinancePaymentMethod;

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, trim: true })
  userEmail!: string;
}
const ReceivablePaymentSchema =
  SchemaFactory.createForClass(ReceivablePayment);

/**
 * Cuenta por cobrar (CxC / fiado) de un cliente. `paidAmount`/`status` se
 * recalculan con cada abono. Montos en COP entero. Puede originarse de una
 * venta a crédito del POS (`saleId`) o registrarse manualmente.
 */
@Schema({ timestamps: true, collection: 'finance_receivables' })
export class FinanceReceivable {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  /** Cliente registrado dueño de la cuenta (obligatorio para CxC nuevas). */
  @Prop({ type: Types.ObjectId, ref: 'Customer', index: true })
  customerId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  customerName!: string;

  /** Cédula / NIT del cliente (identifica y agrupa por cliente). */
  @Prop({ trim: true })
  customerDoc?: string;

  @Prop({ trim: true })
  customerPhone?: string;

  /** Venta a crédito que originó la cuenta (si vino del POS). */
  @Prop({ type: Types.ObjectId, ref: 'Sale', default: null })
  saleId?: Types.ObjectId | null;

  /** Número de la venta / documento de referencia. */
  @Prop({ trim: true })
  docNumber?: string;

  /** Fecha de emisión YYYY-MM-DD. */
  @Prop({ required: true, trim: true })
  issueDate!: string;

  /** Fecha de vencimiento YYYY-MM-DD. */
  @Prop({ required: true, trim: true })
  dueDate!: string;

  @Prop({ required: true, min: 0 })
  amount!: number;

  @Prop({ default: 0, min: 0 })
  paidAmount!: number;

  @Prop({ required: true, enum: RECEIVABLE_STATUSES, default: 'open' })
  status!: ReceivableStatus;

  @Prop({ type: [ReceivablePaymentSchema], default: [] })
  payments!: ReceivablePayment[];

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, trim: true })
  createdByEmail!: string;
}

export const FinanceReceivableSchema =
  SchemaFactory.createForClass(FinanceReceivable);

FinanceReceivableSchema.index({ sedeId: 1, status: 1 });
FinanceReceivableSchema.index({ status: 1, dueDate: 1 });
