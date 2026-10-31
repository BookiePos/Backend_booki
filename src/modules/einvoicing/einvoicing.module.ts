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
import { TransmisionDianService } from './application/transmision-dian.service';
import {
  ARMADOR_XML_DIAN,
  FIRMANTE_DIAN,
  FirmanteP12,
  PROVEEDOR_TRANSMISOR_DIAN,
  ProveedorTransmisorPorEmisor,
} from './application/transmision-dian.puertos';
import { ArmadorUblFactura } from './application/armador-ubl';
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
  providers: [
    EinvoicingService,
    FiscalEmittersService,
    CertificadoEmisorService,
    TransmisionDianService,
    // Fase 5A: el builder UBL arma la factura de venta; los demás tipos siguen en 501. El
    // proveedor arma DirectoDian con el .p12 del emisor; TRANSPORTE_HTTP_DIAN es opcional (sin él, fetch).
    { provide: ARMADOR_XML_DIAN, useClass: ArmadorUblFactura },
    { provide: FIRMANTE_DIAN, useClass: FirmanteP12 },
    { provide: PROVEEDOR_TRANSMISOR_DIAN, useClass: ProveedorTransmisorPorEmisor },
  ],
  exports: [
    EinvoicingService,
    FiscalEmittersService,
    CertificadoEmisorService,
    TransmisionDianService,
  ],
})
export class EinvoicingModule {}
