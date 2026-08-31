import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SupplierItemAliasDocument = HydratedDocument<SupplierItemAlias>;

/**
 * Cómo llama un proveedor a un producto nuestro.
 *
 * Es la memoria del emparejamiento: la primera vez, la persona dice que
 * "GASEOSA POSTOB 350 X12" es tal producto del inventario; a partir de ahí, esa
 * misma línea se empareja sola en cada factura de ese proveedor. Sin esto, la
 * funcionalidad exige el mismo trabajo manual todos los meses.
 *
 * Se guarda por proveedor y no global a propósito: dos proveedores usan
 * abreviaturas distintas, y una coincidencia cruzada emparejaría mal.
 */
@Schema({ timestamps: true, collection: 'supplier_item_aliases' })
export class SupplierItemAlias {
  @Prop({ type: Types.ObjectId, ref: 'Supplier', required: true })
  supplierId!: Types.ObjectId;

  /** Descripción del proveedor ya normalizada (`normalizeText`). */
  @Prop({ required: true, trim: true })
  rawText!: string;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  /** Veces que se ha usado. Sirve para depurar emparejamientos dudosos. */
  @Prop({ default: 1 })
  hits!: number;

  @Prop()
  lastUsedAt?: Date;
}

export const SupplierItemAliasSchema =
  SchemaFactory.createForClass(SupplierItemAlias);

SupplierItemAliasSchema.index(
  { supplierId: 1, rawText: 1 },
  { unique: true },
);
