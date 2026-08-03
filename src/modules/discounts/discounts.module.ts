import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  Discount,
  DiscountSchema,
} from './infrastructure/schemas/discount.schema';
import { DiscountsService } from './application/discounts.service';
import { DiscountsController } from './infrastructure/discounts.controller';

@Module({
  imports: [
    TenantMongooseModule.forFeature([{ name: Discount.name, schema: DiscountSchema }]),
  ],
  controllers: [DiscountsController],
  providers: [DiscountsService],
  // Reexporta el modelo (proxy multi-empresa) para que SalesModule pueda
  // inyectar el modelo Discount.
  exports: [DiscountsService, TenantMongooseModule],
})
export class DiscountsModule {}
