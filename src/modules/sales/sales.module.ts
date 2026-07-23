import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Sale, SaleSchema } from './infrastructure/schemas/sale.schema';
import {
  Counter,
  CounterSchema,
} from './infrastructure/schemas/counter.schema';
import {
  StockItem,
  StockItemSchema,
} from '../inventory/infrastructure/schemas/stock-item.schema';
import { SalesService } from './application/sales.service';
import { SalesController } from './infrastructure/sales.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { SedesModule } from '../sedes/sedes.module';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  imports: [
    InventoryModule,
    SedesModule,
    CatalogModule,
    MongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: StockItem.name, schema: StockItemSchema },
    ]),
  ],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
