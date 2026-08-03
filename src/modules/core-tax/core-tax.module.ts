import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
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
    TenantMongooseModule.forFeature([{ name: TaxRate.name, schema: TaxRateSchema }]),
  ],
  controllers: [TaxController],
  providers: [TaxService],
  exports: [TaxService],
})
export class CoreTaxModule {}
