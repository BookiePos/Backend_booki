import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Sale, SaleSchema } from '../sales/infrastructure/schemas/sale.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CoreLedgerModule } from '../core-ledger/core-ledger.module';
import { ReportsService } from './application/reports.service';
import { ReportsController } from './infrastructure/reports.controller';

@Module({
  imports: [
    CoreAuthModule,
    CoreLedgerModule,
    MongooseModule.forFeature([{ name: Sale.name, schema: SaleSchema }]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class CoreReportsModule {}
