import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** Un renglón del asiento: cae sobre una cuenta por el débito o el crédito. */
@Schema({ _id: false })
export class JournalLine {
  @Prop({ required: true, trim: true })
  accountCode!: string;

  @Prop({ required: true, trim: true })
  accountName!: string;

  /** Montos COP entero. Un renglón usa débito O crédito, no ambos. */
  @Prop({ default: 0, min: 0 })
  debit!: number;

  @Prop({ default: 0, min: 0 })
  credit!: number;

  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  @Prop({ trim: true })
  memo?: string;
}
export const JournalLineSchema = SchemaFactory.createForClass(JournalLine);

export type JournalEntryDocument = HydratedDocument<JournalEntry>;

/**
 * Asiento contable. Inmutable: los renglones y montos no se editan nunca. Para
 * corregir se emite un contra-asiento (reverse) que enlaza con `reversalOf`.
 */
@Schema({ timestamps: true, collection: 'ledger_journal_entries' })
export class JournalEntry {
  /** Consecutivo legible (AS-000001). */
  @Prop({ required: true, unique: true })
  number!: string;

  @Prop({ required: true })
  date!: string;

  /** Evento de negocio que lo originó: sale, expense, payment, adjustment, manual… */
  @Prop({ required: true, trim: true })
  sourceType!: string;

  @Prop({ trim: true })
  sourceId?: string;

  @Prop({ trim: true })
  memo?: string;

  @Prop({ type: [JournalLineSchema], required: true })
  lines!: JournalLine[];

  @Prop({ required: true, min: 0 })
  totalDebit!: number;

  @Prop({ required: true, min: 0 })
  totalCredit!: number;

  /** Si es un contra-asiento, el id del asiento que reversa. */
  @Prop({ type: Types.ObjectId, ref: 'JournalEntry', default: null })
  reversalOf?: Types.ObjectId | null;

  /** Si ya fue reversado, el id del contra-asiento (único puntero mutable). */
  @Prop({ type: Types.ObjectId, ref: 'JournalEntry', default: null })
  reversedBy?: Types.ObjectId | null;

  @Prop({ trim: true })
  createdByEmail?: string;
}

export const JournalEntrySchema = SchemaFactory.createForClass(JournalEntry);

JournalEntrySchema.index({ date: -1 });
JournalEntrySchema.index({ sourceType: 1, sourceId: 1 });
JournalEntrySchema.index({ 'lines.accountCode': 1 });
