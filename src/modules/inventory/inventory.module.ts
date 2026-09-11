import { Module, forwardRef } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { CatalogModule } from '../catalog/catalog.module';
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
import { Sede, SedeSchema } from '../sedes/infrastructure/schemas/sede.schema';

@Module({
  imports: [
    SedesModule,
    // forwardRef: el catálogo importa a su vez el inventario (ciclo controlado).
    // ProductsService usa CatalogService para reflejar en el POS los ítems con
    // precio de venta.
    forwardRef(() => CatalogModule),
    // Modelos referenciados por `populate`. Se registran aquí (mismo token que
    // en su módulo de origen → misma instancia cacheada por empresa) para poder
    // inyectarlos y pasarlos EXPLÍCITOS a populate: los modelos se compilan de
    // forma perezosa sobre la base de cada empresa, y si el referenciado aún no
    // lo estaba, mongoose lanzaba MissingSchemaError (500).
    TenantMongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: ProductCategory.name, schema: ProductCategorySchema },
      { name: StockItem.name, schema: StockItemSchema },
      { name: StockLot.name, schema: StockLotSchema },
      { name: StockMovement.name, schema: StockMovementSchema },
      { name: Sede.name, schema: SedeSchema },
    ]),
  ],
  controllers: [InventoryController],
  providers: [ProductsService, StockService],
  exports: [ProductsService, StockService],
})
export class InventoryModule {}
