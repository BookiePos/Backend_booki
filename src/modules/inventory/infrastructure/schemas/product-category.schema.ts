import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProductCategoryDocument = HydratedDocument<ProductCategory>;

@Schema({ timestamps: true, collection: 'product_categories' })
export class ProductCategory {
  @Prop({ required: true, unique: true, trim: true })
  name!: string;

  @Prop({ default: true })
  active!: boolean;
}

export const ProductCategorySchema =
  SchemaFactory.createForClass(ProductCategory);
