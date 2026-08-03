import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { Sale, SaleSchema } from '../sales/infrastructure/schemas/sale.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CoreLedgerModule } from '../core-ledger/core-ledger.module';
import { ReportsService } from './application/reports.service';
import { ReportsController } from './infrastructure/reports.controller';

@Module({
  imports: [
    CoreAuthModule,
    CoreLedgerModule,
    TenantMongooseModule.forFeature([{ name: Sale.name, schema: SaleSchema }]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class CoreReportsModule {}
