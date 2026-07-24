import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  CajaSession,
  CajaSessionSchema,
} from './infrastructure/schemas/caja-session.schema';
import {
  CajaMovement,
  CajaMovementSchema,
} from './infrastructure/schemas/caja-movement.schema';
import { Sale, SaleSchema } from '../sales/infrastructure/schemas/sale.schema';
import { Order, OrderSchema } from '../sales/infrastructure/schemas/order.schema';
import { CajaService } from './application/caja.service';
import { CajaController } from './infrastructure/caja.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CajaSession.name, schema: CajaSessionSchema },
      { name: CajaMovement.name, schema: CajaMovementSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
  ],
  controllers: [CajaController],
  providers: [CajaService],
  exports: [CajaService],
})
export class CajaModule {}
