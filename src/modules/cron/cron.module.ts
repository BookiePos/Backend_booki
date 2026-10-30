import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { FinanceModule } from '../finance/finance.module';
import { EinvoicingModule } from '../einvoicing/einvoicing.module';
import { CronController } from './infrastructure/cron.controller';

/** Endpoint que Vercel Cron llama para correr los barridos periódicos. */
@Module({
  imports: [BillingModule, FinanceModule, EinvoicingModule],
  controllers: [CronController],
})
export class CronModule {}
