import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  Supplier,
  SupplierSchema,
} from './infrastructure/schemas/supplier.schema';
import { SuppliersService } from './application/suppliers.service';
import { SuppliersController } from './infrastructure/suppliers.controller';

@Module({
  imports: [
    TenantMongooseModule.forFeature([
      { name: Supplier.name, schema: SupplierSchema },
    ]),
  ],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
