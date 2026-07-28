import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  PAYABLE_STATUSES,
  PayableStatus,
  PAYMENT_METHODS,
  FinancePaymentMethod,
} from '../../domain/finance.constants';

export type FinancePayableDocument = HydratedDocument<FinancePayable>;

/** Abono a una cuenta por pagar (embebido). */
@Schema({ _id: false })
export class PayablePayment {
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
const PayablePaymentSchema = SchemaFactory.createForClass(PayablePayment);

/**
 * Cuenta por pagar (CxP) a un proveedor. `paidAmount`/`status` se recalculan
 * con cada abono. Montos en COP entero.
 */
@Schema({ timestamps: true, collection: 'finance_payables' })
export class FinancePayable {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Supplier' })
  supplierId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  supplierName!: string;

  @Prop({ type: Types.ObjectId, ref: 'FinanceCategory' })
  categoryId?: Types.ObjectId;

  /** Número de factura/documento del proveedor. */
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

  @Prop({ required: true, enum: PAYABLE_STATUSES, default: 'open' })
  status!: PayableStatus;

  @Prop({ type: [PayablePaymentSchema], default: [] })
  payments!: PayablePayment[];

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, trim: true })
  createdByEmail!: string;
}

export const FinancePayableSchema =
  SchemaFactory.createForClass(FinancePayable);

FinancePayableSchema.index({ sedeId: 1, status: 1 });
FinancePayableSchema.index({ status: 1, dueDate: 1 });
