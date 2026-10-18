import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { RestaurantModule } from '../restaurant/restaurant.module';
import { SedesModule } from '../sedes/sedes.module';
import {
  CatalogProduct,
  CatalogProductSchema,
} from '../catalog/infrastructure/schemas/catalog-product.schema';
import { Product, ProductSchema } from '../inventory/infrastructure/schemas/product.schema';
import {
  ProductCategory,
  ProductCategorySchema,
} from '../inventory/infrastructure/schemas/product-category.schema';
import { OnboardingService } from './application/onboarding.service';
import { OnboardingController } from './infrastructure/onboarding.controller';

/** Plantillas de menú y catálogo de ejemplo por tipo de negocio (ítem 6.6). */
@Module({
  imports: [
    CatalogModule,
    InventoryModule,
    RestaurantModule,
    SedesModule,
    TenantMongooseModule.forFeature([
      { name: CatalogProduct.name, schema: CatalogProductSchema },
      { name: Product.name, schema: ProductSchema },
      { name: ProductCategory.name, schema: ProductCategorySchema },
    ]),
  ],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
