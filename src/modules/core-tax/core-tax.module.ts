import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  TaxRate,
  TaxRateSchema,
} from './infrastructure/schemas/tax-rate.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { TaxService } from './application/tax.service';
import { TaxController } from './infrastructure/tax.controller';

@Module({
  imports: [
    CoreAuthModule,
    MongooseModule.forFeature([{ name: TaxRate.name, schema: TaxRateSchema }]),
  ],
  controllers: [TaxController],
  providers: [TaxService],
  exports: [TaxService],
})
export class CoreTaxModule {}
