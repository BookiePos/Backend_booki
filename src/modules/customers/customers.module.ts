import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Customer,
  CustomerSchema,
} from './infrastructure/schemas/customer.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CustomersService } from './application/customers.service';
import { CustomersController } from './infrastructure/customers.controller';

@Module({
  imports: [
    CoreAuthModule,
    MongooseModule.forFeature([{ name: Customer.name, schema: CustomerSchema }]),
  ],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
