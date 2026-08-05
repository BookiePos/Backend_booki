import { Module, forwardRef } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  CatalogProduct,
  CatalogProductSchema,
} from './infrastructure/schemas/catalog-product.schema';
import {
  Product,
  ProductSchema,
} from '../inventory/infrastructure/schemas/product.schema';
import {
  ProductCategory,
  ProductCategorySchema,
} from '../inventory/infrastructure/schemas/product-category.schema';
import { CatalogService } from './application/catalog.service';
import { CatalogController } from './infrastructure/catalog.controller';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    forwardRef(() => InventoryModule),
    // Se registran también los modelos referenciados por `populate` (mismo token
    // que en InventoryModule → misma instancia cacheada por tenant), para poder
    // inyectarlos y pasarlos explícitos a populate.
    TenantMongooseModule.forFeature([
      { name: CatalogProduct.name, schema: CatalogProductSchema },
      { name: Product.name, schema: ProductSchema },
      { name: ProductCategory.name, schema: ProductCategorySchema },
    ]),
  ],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
