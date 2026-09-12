import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  DeliveryZone,
  DeliveryZoneSchema,
} from './infrastructure/schemas/delivery-zone.schema';
import { DeliveryZonesService } from './application/delivery-zones.service';
import { DeliveryController } from './infrastructure/delivery.controller';

@Module({
  imports: [
    TenantMongooseModule.forFeature([
      { name: DeliveryZone.name, schema: DeliveryZoneSchema },
    ]),
  ],
  controllers: [DeliveryController],
  providers: [DeliveryZonesService],
  // Lo exporta para que la venta pueda resolver la tarifa de la zona: el
  // precio del domicilio SIEMPRE sale del servidor, nunca del navegador.
  exports: [DeliveryZonesService],
})
export class DeliveryModule {}
