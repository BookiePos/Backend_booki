import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { Sale, SaleSchema } from '../sales/infrastructure/schemas/sale.schema';
import {
  StockLot,
  StockLotSchema,
} from '../inventory/infrastructure/schemas/stock-lot.schema';
import {
  StockMovement,
  StockMovementSchema,
} from '../inventory/infrastructure/schemas/stock-movement.schema';
import {
  Product,
  ProductSchema,
} from '../inventory/infrastructure/schemas/product.schema';
import {
  ProductionOrder,
  ProductionOrderSchema,
} from '../production/infrastructure/schemas/production-order.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CoreLedgerModule } from '../core-ledger/core-ledger.module';
import { ReportsService } from './application/reports.service';
import { TraceabilityService } from './application/traceability.service';
import { ReportsController } from './infrastructure/reports.controller';

@Module({
  imports: [
    CoreAuthModule,
    CoreLedgerModule,
    // Se registran los ESQUEMAS y no los módulos de origen: la trazabilidad
    // solo lee, y cruzar módulos aquí crearía ciclos (ventas ya depende de
    // inventario, e inventario de nada de esto). Mismo token → misma instancia
    // cacheada por empresa.
    TenantMongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: StockLot.name, schema: StockLotSchema },
      { name: StockMovement.name, schema: StockMovementSchema },
      { name: Product.name, schema: ProductSchema },
      { name: ProductionOrder.name, schema: ProductionOrderSchema },
    ]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService, TraceabilityService],
  exports: [ReportsService, TraceabilityService],
})
export class CoreReportsModule {}
