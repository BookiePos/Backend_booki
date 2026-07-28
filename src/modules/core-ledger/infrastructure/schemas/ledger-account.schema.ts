import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { ACCOUNT_TYPES, AccountType } from '../../domain/ledger.constants';

export type LedgerAccountDocument = HydratedDocument<LedgerAccount>;

/** Cuenta del plan contable. El `code` es único y estable. */
@Schema({ timestamps: true, collection: 'ledger_accounts' })
export class LedgerAccount {
  @Prop({ required: true, unique: true, trim: true })
  code!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, enum: ACCOUNT_TYPES })
  type!: AccountType;

  @Prop({ default: false })
  system!: boolean;

  @Prop({ default: true })
  active!: boolean;
}

export const LedgerAccountSchema = SchemaFactory.createForClass(LedgerAccount);

LedgerAccountSchema.index({ type: 1, code: 1 });
