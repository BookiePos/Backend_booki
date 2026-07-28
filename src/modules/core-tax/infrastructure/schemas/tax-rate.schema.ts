import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { TAX_KINDS, TaxKind } from '../../domain/tax.constants';

export type TaxRateDocument = HydratedDocument<TaxRate>;

/**
 * Una vigencia de un impuesto. `code + effectiveFrom` es único: cambiar la
 * tarifa abre una vigencia nueva y conserva el histórico. La tarifa vigente a
 * una fecha es la de mayor `effectiveFrom <= fecha`.
 */
@Schema({ timestamps: true, collection: 'core_tax_rates' })
export class TaxRate {
  /** Código estable del impuesto (p.ej. IVA_19, INC_8). */
  @Prop({ required: true, trim: true, uppercase: true })
  code!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, enum: TAX_KINDS })
  kind!: TaxKind;

  /** Tarifa en porcentaje (19 = 19%). */
  @Prop({ required: true, min: 0 })
  rate!: number;

  /** Inicio de vigencia (YYYY-MM-DD). */
  @Prop({ required: true })
  effectiveFrom!: string;

  @Prop({ default: true })
  active!: boolean;

  @Prop({ default: false })
  system!: boolean;

  @Prop({ trim: true })
  note?: string;

  @Prop({ trim: true })
  createdByEmail?: string;
}

export const TaxRateSchema = SchemaFactory.createForClass(TaxRate);

TaxRateSchema.index({ code: 1, effectiveFrom: 1 }, { unique: true });
TaxRateSchema.index({ kind: 1 });
