import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SupplierDocument = HydratedDocument<Supplier>;

export const SUPPLIER_DOC_TYPES = ['NIT', 'CC', 'CE'] as const;
export type SupplierDocType = (typeof SUPPLIER_DOC_TYPES)[number];

/** Proveedor del restaurante (compras de mercancía e insumos). */
@Schema({ timestamps: true, collection: 'suppliers' })
export class Supplier {
  /** Razón social o nombre comercial. */
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, enum: SUPPLIER_DOC_TYPES, default: 'NIT' })
  docType!: SupplierDocType;

  @Prop({ required: true, trim: true })
  docNumber!: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ trim: true })
  email?: string;

  @Prop({ trim: true })
  contactName?: string;

  @Prop({ trim: true })
  address?: string;

  @Prop({ trim: true })
  city?: string;

  /** Rubro que surte (carnes, lácteos, aseo…). Texto libre por ahora. */
  @Prop({ trim: true })
  category?: string;

  @Prop({ trim: true })
  notes?: string;

  @Prop({ default: true })
  active!: boolean;
}

export const SupplierSchema = SchemaFactory.createForClass(Supplier);

SupplierSchema.index({ docType: 1, docNumber: 1 }, { unique: true });
SupplierSchema.index({ name: 'text' });
