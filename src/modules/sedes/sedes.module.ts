import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { Sede, SedeSchema } from './infrastructure/schemas/sede.schema';
import { SedesService } from './application/sedes.service';
import { SedesController } from './infrastructure/sedes.controller';
import { EmisorDeSedeService } from './application/emisor-de-sede.service';
import {
  FiscalEmitter,
  FiscalEmitterSchema,
} from '../einvoicing/infrastructure/schemas/fiscal-emitter.schema';

@Module({
  imports: [
    // El emisor fiscal se registra también aquí (como la sede en einvoicing):
    // importar EinvoicingModule sería un ciclo, porque él importa este módulo.
    TenantMongooseModule.forFeature([
      { name: Sede.name, schema: SedeSchema },
      { name: FiscalEmitter.name, schema: FiscalEmitterSchema },
    ]),
  ],
  controllers: [SedesController],
  providers: [SedesService, EmisorDeSedeService],
  exports: [SedesService],
})
export class SedesModule {}
