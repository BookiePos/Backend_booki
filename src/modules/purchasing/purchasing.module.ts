import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PurchaseOrder,
  PurchaseOrderSchema,
} from './infrastructure/schemas/purchase-order.schema';
import {
  FinancePayable,
  FinancePayableSchema,
} from '../finance/infrastructure/schemas/finance-payable.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CoreTaxModule } from '../core-tax/core-tax.module';
import { CoreLedgerModule } from '../core-ledger/core-ledger.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchasingService } from './application/purchasing.service';
import { PurchasingController } from './infrastructure/purchasing.controller';

@Module({
  imports: [
    CoreAuthModule,
    CoreTaxModule,
    CoreLedgerModule,
    InventoryModule,
    MongooseModule.forFeature([
      { name: PurchaseOrder.name, schema: PurchaseOrderSchema },
      { name: FinancePayable.name, schema: FinancePayableSchema },
    ]),
  ],
  controllers: [PurchasingController],
  providers: [PurchasingService],
  exports: [PurchasingService],
})
export class PurchasingModule {}
