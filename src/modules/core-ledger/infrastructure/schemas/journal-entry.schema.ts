import { Logger } from '@nestjs/common';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  INDICE_ORIGEN_VIVO,
  INDICE_UNA_REVERSA,
} from '../../domain/journal-entry.indices';

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
// Consultas por origen (findBySource, filtros por tipo y sus reversas). No es
// único: los contra-asientos y los originales reversados comparten el origen.
JournalEntrySchema.index({ sourceType: 1, sourceId: 1, reversalOf: 1 });
// Únicos (checklist 1.13): ver `domain/journal-entry.indices.ts`.
JournalEntrySchema.index(
  { ...INDICE_ORIGEN_VIVO.keys },
  {
    ...INDICE_ORIGEN_VIVO.options,
    partialFilterExpression: { ...INDICE_ORIGEN_VIVO.options.partialFilterExpression },
  },
);
JournalEntrySchema.index(
  { ...INDICE_UNA_REVERSA.keys },
  {
    ...INDICE_UNA_REVERSA.options,
    partialFilterExpression: { ...INDICE_UNA_REVERSA.options.partialFilterExpression },
  },
);
JournalEntrySchema.index({ 'lines.accountCode': 1 });

/**
 * Mongoose crea estos índices al compilar el modelo en la base de cada empresa
 * y, si falla (duplicados previos, índice viejo en conflicto), lo calla: el
 * libro quedaría sin la garantía de un asiento vivo por origen. Se deja en el
 * log como error, con la base, para correr el informe de duplicados
 * (`src/datos/2026-10-duplicados-libro-informe.ts`).
 */
// Los specs neutralizan `SchemaFactory` (CLAUDE.md, «Tests») y reciben un
// esquema sin eventos; en ejecución real siempre es un Schema de Mongoose.
JournalEntrySchema.on?.(
  'init',
  (model: { db?: { name?: string }; on(ev: 'index', fn: (err?: Error) => void): unknown }) => {
    model.on('index', (err?: Error) => {
      if (!err) return;
      new Logger('Ledger').error(
        `CONCILIAR: no se crearon los índices del libro en ${model.db?.name ?? '¿base?'}: ${err.message}`,
      );
    });
  },
);
