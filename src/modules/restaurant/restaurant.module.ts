import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  RestaurantTable,
  RestaurantTableSchema,
} from './infrastructure/schemas/restaurant-table.schema';
import {
  RestaurantOrder,
  RestaurantOrderSchema,
} from './infrastructure/schemas/restaurant-order.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { RestaurantService } from './application/restaurant.service';
import { RestaurantController } from './infrastructure/restaurant.controller';

@Module({
  imports: [
    CoreAuthModule,
    MongooseModule.forFeature([
      { name: RestaurantTable.name, schema: RestaurantTableSchema },
      { name: RestaurantOrder.name, schema: RestaurantOrderSchema },
    ]),
  ],
  controllers: [RestaurantController],
  providers: [RestaurantService],
  exports: [RestaurantService],
})
export class RestaurantModule {}
