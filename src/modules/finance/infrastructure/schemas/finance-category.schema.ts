import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  CATEGORY_KINDS,
  CATEGORY_AUTO_SOURCES,
  CategoryAutoSource,
  CategoryKind,
} from '../../domain/finance.constants';

export type FinanceCategoryDocument = HydratedDocument<FinanceCategory>;

/**
 * Categoría financiera. Las de `system` se siembran automáticamente y no se
 * borran; algunas traen su "Real" de otra fuente (`autoSource`). `accountCode`
 * deja la puerta abierta al PUC (plan de cuentas) futuro.
 */
@Schema({ timestamps: true, collection: 'finance_categories' })
export class FinanceCategory {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, enum: CATEGORY_KINDS })
  kind!: CategoryKind;

  /** Cuenta PUC futura (opcional). */
  @Prop({ trim: true })
  accountCode?: string;

  /** Sembrada por el sistema (no se puede borrar). */
  @Prop({ default: false })
  system!: boolean;

  /** Origen automático de su "Real" (ventas/nómina/caja/inventario), o null. */
  @Prop({ type: String, enum: [...CATEGORY_AUTO_SOURCES, null], default: null })
  autoSource?: CategoryAutoSource | null;

  @Prop({ default: true })
  active!: boolean;
}

export const FinanceCategorySchema =
  SchemaFactory.createForClass(FinanceCategory);

FinanceCategorySchema.index({ kind: 1, active: 1 });
FinanceCategorySchema.index({ system: 1 });
