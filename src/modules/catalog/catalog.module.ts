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
import {
  PriceList,
  PriceListSchema,
} from './infrastructure/schemas/price-list.schema';
import { CatalogService } from './application/catalog.service';
import { PriceListsService } from './application/price-lists.service';
import { CatalogController } from './infrastructure/catalog.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { StorageModule } from '../../shared/storage/storage.module';

@Module({
  imports: [
    forwardRef(() => InventoryModule),
    // Fotos de los productos vendibles (Vercel Blob).
    StorageModule,
    // Se registran también los modelos referenciados por `populate` (mismo token
    // que en InventoryModule → misma instancia cacheada por tenant), para poder
    // inyectarlos y pasarlos explícitos a populate.
    TenantMongooseModule.forFeature([
      { name: CatalogProduct.name, schema: CatalogProductSchema },
      { name: PriceList.name, schema: PriceListSchema },
      { name: Product.name, schema: ProductSchema },
      { name: ProductCategory.name, schema: ProductCategorySchema },
    ]),
  ],
  controllers: [CatalogController],
  providers: [CatalogService, PriceListsService],
  // `PriceListsService` sale del módulo porque la venta y la comanda resuelven
  // el precio con él: las dos tienen que cobrar exactamente igual.
  exports: [CatalogService, PriceListsService],
})
export class CatalogModule {}
