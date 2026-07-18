import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

@Schema({ timestamps: true, collection: 'products' })
export class Product {
  /** Código interno único (SKU). Se normaliza a mayúsculas. */
  @Prop({ required: true, unique: true, trim: true, uppercase: true })
  sku!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ type: Types.ObjectId, ref: 'ProductCategory' })
  categoryId?: Types.ObjectId;

  /** Unidad de medida (und, kg, l, paquete...). */
  @Prop({ required: true, trim: true, default: 'und' })
  unit!: string;

  @Prop({ trim: true })
  barcode?: string;

  /** Perecedero: exige lote + fecha de vencimiento en las entradas. */
  @Prop({ default: false })
  perishable!: boolean;

  /** Controla existencias por lote (obligatorio si es perecedero). */
  @Prop({ default: false })
  trackLots!: boolean;

  /** Vida útil típica en días (para sugerir vencimiento al recibir). */
  @Prop({ min: 0 })
  shelfLifeDays?: number;

  /** Stock mínimo por defecto (alerta de reposición). */
  @Prop({ default: 0, min: 0 })
  minStock!: number;

  /** Último costo unitario de compra registrado. */
  @Prop({ default: 0, min: 0 })
  cost!: number;

  /** Precio de venta (el POS podrá refinarlo luego). */
  @Prop({ min: 0 })
  salePrice?: number;

  @Prop({ default: true })
  active!: boolean;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ name: 'text' });
ProductSchema.index({ barcode: 1 }, { sparse: true });
