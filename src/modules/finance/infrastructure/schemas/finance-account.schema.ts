import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  ACCOUNT_TYPES,
  AccountType,
  PAYMENT_METHODS,
  FinancePaymentMethod,
} from '../../domain/finance.constants';

export type FinanceAccountDocument = HydratedDocument<FinanceAccount>;

/**
 * Cuenta de tesorería (banco, efectivo, billetera). El saldo (`balance`) NO se
 * persiste: se calcula como apertura + Σ movimientos. `sedeId` opcional: null =
 * cuenta consolidada del negocio.
 */
@Schema({ timestamps: true, collection: 'finance_accounts' })
export class FinanceAccount {
  @Prop({ type: Types.ObjectId, ref: 'Sede', default: null })
  sedeId?: Types.ObjectId | null;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, enum: ACCOUNT_TYPES })
  type!: AccountType;

  @Prop({ required: true, default: 0 })
  openingBalance!: number;

  @Prop({ default: true })
  active!: boolean;

  /**
   * Métodos de pago que alimentan esta cuenta automáticamente (ventas con
   * tarjeta/transferencia, pagos/cobros por esos medios). Vacío = solo manual.
   */
  @Prop({ type: [String], enum: PAYMENT_METHODS, default: [] })
  autoMethods!: FinancePaymentMethod[];

  @Prop({ trim: true })
  note?: string;

  /** Última conciliación bancaria: fecha del extracto (YYYY-MM-DD). */
  @Prop({ type: String, default: null })
  lastReconciledDate?: string | null;

  /** Saldo del extracto en la última conciliación. */
  @Prop({ type: Number, default: null })
  lastReconciledBalance?: number | null;

  @Prop({ type: Date, default: null })
  lastReconciledAt?: Date | null;
}

export const FinanceAccountSchema =
  SchemaFactory.createForClass(FinanceAccount);

FinanceAccountSchema.index({ sedeId: 1, active: 1 });
