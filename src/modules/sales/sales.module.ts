import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { Sale, SaleSchema } from './infrastructure/schemas/sale.schema';
import {
  SaleReturn,
  SaleReturnSchema,
} from './infrastructure/schemas/sale-return.schema';
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
import { SaleReturnsService } from './application/sale-returns.service';
import { OrdersService } from './application/orders.service';
import { SalesController } from './infrastructure/sales.controller';
import { OrdersController } from './infrastructure/orders.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { SedesModule } from '../sedes/sedes.module';
import { CatalogModule } from '../catalog/catalog.module';
import { DiscountsModule } from '../discounts/discounts.module';
import { CoreLedgerModule } from '../core-ledger/core-ledger.module';
import { TreasuryModule } from '../finance/treasury/treasury.module';
import { CustomersModule } from '../customers/customers.module';
import { CajaModule } from '../caja/caja.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { PayrollModule } from '../payroll/payroll.module';
import { CoreParamsModule } from '../core-params/core-params.module';
import { Sede, SedeSchema } from '../sedes/infrastructure/schemas/sede.schema';

@Module({
  imports: [
    InventoryModule,
    SedesModule,
    CatalogModule,
    DiscountsModule,
    CoreLedgerModule,
    TreasuryModule,
    CustomersModule,
    // La devolución parcial saca la plata por la caja del turno.
    CajaModule,
    // La tarifa del domicilio la pone el servidor, nunca el navegador.
    DeliveryModule,
    PayrollModule,
    CoreParamsModule,
    // Modelos referenciados por `populate`. Se registran aquí (mismo token que
    // en su módulo de origen → misma instancia cacheada por empresa) para poder
    // inyectarlos y pasarlos EXPLÍCITOS a populate: los modelos se compilan de
    // forma perezosa sobre la base de cada empresa, y si el referenciado aún no
    // lo estaba, mongoose lanzaba MissingSchemaError (500).
    TenantMongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: SaleReturn.name, schema: SaleReturnSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: StockItem.name, schema: StockItemSchema },
      { name: CajaSession.name, schema: CajaSessionSchema },
      { name: FinanceReceivable.name, schema: FinanceReceivableSchema },
      { name: Sede.name, schema: SedeSchema },
    ]),
  ],
  controllers: [SalesController, OrdersController],
  providers: [SalesService, OrdersService, SaleReturnsService],
  exports: [SalesService, OrdersService, SaleReturnsService],
})
export class SalesModule {}
