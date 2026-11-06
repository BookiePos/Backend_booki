import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { FinanceModule } from '../finance/finance.module';
import { EinvoicingModule } from '../einvoicing/einvoicing.module';
import { SalesModule } from '../sales/sales.module';
import { CronController } from './infrastructure/cron.controller';

/** Endpoint que Vercel Cron llama para correr los barridos periódicos. */
@Module({
  imports: [BillingModule, FinanceModule, EinvoicingModule, SalesModule],
  controllers: [CronController],
})
export class CronModule {}
