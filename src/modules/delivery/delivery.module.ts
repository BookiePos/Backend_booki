import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  DeliveryZone,
  DeliveryZoneSchema,
} from './infrastructure/schemas/delivery-zone.schema';
import { Sale, SaleSchema } from '../sales/infrastructure/schemas/sale.schema';
import { DeliveryZonesService } from './application/delivery-zones.service';
import { DeliveriesService } from './application/deliveries.service';
import { DeliveryController } from './infrastructure/delivery.controller';
import { DeliveriesController } from './infrastructure/deliveries.controller';

@Module({
  imports: [
    // Se registra el ESQUEMA de la venta y no el módulo: el seguimiento solo
    // lee y marca el estado de la entrega, y cruzar módulos aquí crearía un
    // ciclo (ventas ya depende de este).
    TenantMongooseModule.forFeature([
      { name: DeliveryZone.name, schema: DeliveryZoneSchema },
      { name: Sale.name, schema: SaleSchema },
    ]),
  ],
  controllers: [DeliveryController, DeliveriesController],
  providers: [DeliveryZonesService, DeliveriesService],
  // Lo exporta para que la venta pueda resolver la tarifa de la zona: el
  // precio del domicilio SIEMPRE sale del servidor, nunca del navegador.
  exports: [DeliveryZonesService, DeliveriesService],
})
export class DeliveryModule {}
