import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { RECON_CHANNELS, ReconChannel } from '../../domain/payment-reconciliation';

export type PaymentSettlementDocument = HydratedDocument<PaymentSettlement>;

/**
 * Conciliación de un canal digital de un día contra el extracto (ítem 6.4):
 * lo cobrado por el POS, lo consignado y lo que explica la diferencia
 * (comisión, IVA de la comisión, retenciones). Montos en COP entero.
 */
@Schema({ timestamps: true, collection: 'payment_settlements' })
export class PaymentSettlement {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true })
  sedeId!: Types.ObjectId;

  /** Día de las ventas conciliadas (YYYY-MM-DD, hora de Colombia). */
  @Prop({ required: true, trim: true })
  date!: string;

  @Prop({ required: true, enum: RECON_CHANNELS })
  channel!: ReconChannel;

  /** Franquicia del datáfono ('' si no aplica o no se sabe). */
  @Prop({ default: '' })
  franchise!: string;

  /** `datafono:visa`, `nequi`...: junto con sede y fecha identifica la conciliación. */
  @Prop({ required: true })
  key!: string;

  /** Lo que el POS cobró ese día por ese canal (bruto), calculado por el servidor. */
  @Prop({ required: true, min: 0 })
  expected!: number;

  @Prop({ default: 0, min: 0 })
  tickets!: number;

  /** Lo que el adquirente o la billetera consignaron. */
  @Prop({ required: true, min: 0 })
  statementAmount!: number;

  @Prop({ default: 0, min: 0 })
  commission!: number;

  @Prop({ default: 0, min: 0 })
  commissionIva!: number;

  @Prop({ default: 0, min: 0 })
  retefuente!: number;

  @Prop({ default: 0, min: 0 })
  reteIca!: number;

  @Prop({ default: 0, min: 0 })
  reteIva!: number;

  /** expected − (consignado + comisión + IVA + retenciones). 0 = cuadra. */
  @Prop({ required: true })
  difference!: number;

  @Prop({ required: true, enum: ['reconciled', 'difference'] })
  status!: 'reconciled' | 'difference';

  @Prop({ required: true, enum: ['manual', 'csv'], default: 'manual' })
  source!: 'manual' | 'csv';

  @Prop({ trim: true, maxlength: 200 })
  note?: string;

  @Prop({ required: true })
  createdByEmail!: string;
}

export const PaymentSettlementSchema = SchemaFactory.createForClass(PaymentSettlement);

// Una conciliación por sede, día y canal: un reintento no duplica el asiento.
PaymentSettlementSchema.index({ sedeId: 1, date: 1, key: 1 }, { unique: true });
