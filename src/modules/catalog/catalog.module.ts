import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  CatalogProduct,
  CatalogProductSchema,
} from './infrastructure/schemas/catalog-product.schema';
import { CatalogService } from './application/catalog.service';
import { CatalogController } from './infrastructure/catalog.controller';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    InventoryModule,
    MongooseModule.forFeature([
      { name: CatalogProduct.name, schema: CatalogProductSchema },
    ]),
  ],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
