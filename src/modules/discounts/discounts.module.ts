import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Discount,
  DiscountSchema,
} from './infrastructure/schemas/discount.schema';
import { DiscountsService } from './application/discounts.service';
import { DiscountsController } from './infrastructure/discounts.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Discount.name, schema: DiscountSchema }]),
  ],
  controllers: [DiscountsController],
  providers: [DiscountsService],
  // Exporta MongooseModule para que SalesModule pueda inyectar el modelo Discount.
  exports: [DiscountsService, MongooseModule],
})
export class DiscountsModule {}
