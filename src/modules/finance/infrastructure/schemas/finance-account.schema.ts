import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ACCOUNT_TYPES, AccountType } from '../../domain/finance.constants';

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

  @Prop({ trim: true })
  note?: string;
}

export const FinanceAccountSchema =
  SchemaFactory.createForClass(FinanceAccount);

FinanceAccountSchema.index({ sedeId: 1, active: 1 });
