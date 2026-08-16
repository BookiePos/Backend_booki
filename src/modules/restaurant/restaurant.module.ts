import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  RestaurantTable,
  RestaurantTableSchema,
} from './infrastructure/schemas/restaurant-table.schema';
import {
  RestaurantOrder,
  RestaurantOrderSchema,
} from './infrastructure/schemas/restaurant-order.schema';
import {
  Counter,
  CounterSchema,
} from '../sales/infrastructure/schemas/counter.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CoreParamsModule } from '../core-params/core-params.module';
import { CoreTaxModule } from '../core-tax/core-tax.module';
import { RestaurantService } from './application/restaurant.service';
import { RestaurantController } from './infrastructure/restaurant.controller';

@Module({
  imports: [
    CoreAuthModule,
    CoreParamsModule,
    CoreTaxModule,
    TenantMongooseModule.forFeature([
      { name: RestaurantTable.name, schema: RestaurantTableSchema },
      { name: RestaurantOrder.name, schema: RestaurantOrderSchema },
      { name: Counter.name, schema: CounterSchema },
    ]),
  ],
  controllers: [RestaurantController],
  providers: [RestaurantService],
  exports: [RestaurantService],
})
export class RestaurantModule {}
