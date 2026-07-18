import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Product,
  ProductSchema,
} from './infrastructure/schemas/product.schema';
import {
  ProductCategory,
  ProductCategorySchema,
} from './infrastructure/schemas/product-category.schema';
import {
  StockItem,
  StockItemSchema,
} from './infrastructure/schemas/stock-item.schema';
import {
  StockLot,
  StockLotSchema,
} from './infrastructure/schemas/stock-lot.schema';
import {
  StockMovement,
  StockMovementSchema,
} from './infrastructure/schemas/stock-movement.schema';
import { ProductsService } from './application/products.service';
import { StockService } from './application/stock.service';
import { InventoryController } from './infrastructure/inventory.controller';
import { SedesModule } from '../sedes/sedes.module';

@Module({
  imports: [
    SedesModule,
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: ProductCategory.name, schema: ProductCategorySchema },
      { name: StockItem.name, schema: StockItemSchema },
      { name: StockLot.name, schema: StockLotSchema },
      { name: StockMovement.name, schema: StockMovementSchema },
    ]),
  ],
  controllers: [InventoryController],
  providers: [ProductsService, StockService],
  exports: [ProductsService, StockService],
})
export class InventoryModule {}
