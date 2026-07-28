import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Sale, SaleSchema } from './infrastructure/schemas/sale.schema';
import { Order, OrderSchema } from './infrastructure/schemas/order.schema';
import {
  Counter,
  CounterSchema,
} from './infrastructure/schemas/counter.schema';
import {
  StockItem,
  StockItemSchema,
} from '../inventory/infrastructure/schemas/stock-item.schema';
import {
  CajaSession,
  CajaSessionSchema,
} from '../caja/infrastructure/schemas/caja-session.schema';
import {
  FinanceReceivable,
  FinanceReceivableSchema,
} from '../finance/infrastructure/schemas/finance-receivable.schema';
import { SalesService } from './application/sales.service';
import { OrdersService } from './application/orders.service';
import { SalesController } from './infrastructure/sales.controller';
import { OrdersController } from './infrastructure/orders.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { SedesModule } from '../sedes/sedes.module';
import { CatalogModule } from '../catalog/catalog.module';
import { DiscountsModule } from '../discounts/discounts.module';

@Module({
  imports: [
    InventoryModule,
    SedesModule,
    CatalogModule,
    DiscountsModule,
    MongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: StockItem.name, schema: StockItemSchema },
      { name: CajaSession.name, schema: CajaSessionSchema },
      { name: FinanceReceivable.name, schema: FinanceReceivableSchema },
    ]),
  ],
  controllers: [SalesController, OrdersController],
  providers: [SalesService, OrdersService],
  exports: [SalesService],
})
export class SalesModule {}
