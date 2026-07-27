import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  CATALOG_SOURCE_TYPES,
  CatalogSourceType,
  IVA_RATES,
  IVA_TYPES,
  IvaRate,
  IvaType,
} from '../../domain/catalog.constants';

/** Línea de receta: un ingrediente de inventario y cuánto consume. */
@Schema({ _id: false })
export class RecipeLine {
  /** Ítem de inventario (materia prima / producto) que se consume. */
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  /** Cantidad consumida por unidad vendida, en la unidad del ítem. */
  @Prop({ required: true, min: 0 })
  qty!: number;
}

export const RecipeLineSchema = SchemaFactory.createForClass(RecipeLine);

export type CatalogProductDocument = HydratedDocument<CatalogProduct>;

/**
 * Producto vendible del POS. No guarda existencias propias: al venderse,
 * "arrastra" del inventario según su fuente (ítem directo o receta).
 */
@Schema({ timestamps: true, collection: 'catalog_products' })
export class CatalogProduct {
  /** Código interno único (SKU). Se normaliza a mayúsculas. */
  @Prop({ required: true, unique: true, trim: true, uppercase: true })
  sku!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ type: Types.ObjectId, ref: 'ProductCategory' })
  categoryId?: Types.ObjectId;

  /** Precio de venta al público (YA incluye IVA). */
  @Prop({ required: true, min: 0, default: 0 })
  salePrice!: number;

  /** Tarifa de IVA del producto (0/5/19). El precio ya la incluye. */
  @Prop({ required: true, enum: [...IVA_RATES], default: 19 })
  ivaRate!: IvaRate;

  /** Tratamiento de IVA: gravado / exento / excluido. */
  @Prop({ required: true, enum: [...IVA_TYPES], default: 'gravado' })
  ivaType!: IvaType;

  /** Cómo se abastece: directo del inventario o con receta. */
  @Prop({ required: true, enum: CATALOG_SOURCE_TYPES, default: 'inventory' })
  sourceType!: CatalogSourceType;

  // ── Fuente inventario ──────────────────────────────────────────────────────
  /** Ítem de inventario vinculado (solo si sourceType = inventory). */
  @Prop({ type: Types.ObjectId, ref: 'Product' })
  inventoryProductId?: Types.ObjectId;

  /** Unidades de inventario que consume cada unidad vendida (por defecto 1). */
  @Prop({ min: 0, default: 1 })
  qtyPerUnit?: number;

  // ── Fuente receta ──────────────────────────────────────────────────────────
  /** Ingredientes y cantidades (solo si sourceType = recipe). */
  @Prop({ type: [RecipeLineSchema], default: [] })
  recipe!: RecipeLine[];

  @Prop({ default: true })
  active!: boolean;
}

export const CatalogProductSchema =
  SchemaFactory.createForClass(CatalogProduct);

CatalogProductSchema.index({ name: 'text' });
