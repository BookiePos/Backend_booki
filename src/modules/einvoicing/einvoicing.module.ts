import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  ElectronicDocument,
  ElectronicDocumentSchema,
} from './infrastructure/schemas/electronic-document.schema';
import {
  Counter,
  CounterSchema,
} from '../sales/infrastructure/schemas/counter.schema';
import {
  FiscalEmitter,
  FiscalEmitterSchema,
} from './infrastructure/schemas/fiscal-emitter.schema';
import { Sede, SedeSchema } from '../sedes/infrastructure/schemas/sede.schema';
import { EinvoicingService } from './application/einvoicing.service';
import { FiscalEmittersService } from './application/fiscal-emitters.service';
import { CertificadoEmisorService } from './application/certificado-emisor.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { CoreAuditModule } from '../core-audit/core-audit.module';
import { EinvoicingController } from './infrastructure/einvoicing.controller';
import { SalesModule } from '../sales/sales.module';
import { SedesModule } from '../sedes/sedes.module';
import { ControlModule } from '../control/control.module';

@Module({
  imports: [
    TenantMongooseModule.forFeature([
      { name: ElectronicDocument.name, schema: ElectronicDocumentSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: FiscalEmitter.name, schema: FiscalEmitterSchema },
      { name: Sede.name, schema: SedeSchema },
    ]),
    SalesModule,
    SedesModule,
    ControlModule,
    StorageModule,
    CoreAuditModule,
  ],
  controllers: [EinvoicingController],
  providers: [EinvoicingService, FiscalEmittersService, CertificadoEmisorService],
  exports: [EinvoicingService, FiscalEmittersService, CertificadoEmisorService],
})
export class EinvoicingModule {}
