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
import {
  PayrollEDocument,
  PayrollEDocumentSchema,
} from './infrastructure/schemas/payroll-e-document.schema';
import { PayrollHabilitacion, PayrollHabilitacionSchema } from './infrastructure/schemas/payroll-habilitacion.schema';
import { PayrollRun, PayrollRunSchema } from '../payroll/infrastructure/schemas/payroll-run.schema';
import { PayrollDeduction, PayrollDeductionSchema } from '../payroll/infrastructure/schemas/payroll-deduction.schema';
import { PayrollLiquidacion, PayrollLiquidacionSchema } from '../payroll/infrastructure/schemas/payroll-liquidacion.schema';
import { EmployeesModule } from '../employees/employees.module';
import { NominaPeriodoService } from './application/nomina-periodo.service';
import { HabilitacionNominaService } from './application/habilitacion-nomina.service';
import { HabilitacionFacturaService } from './application/habilitacion-factura.service';
import { EinvoicingHabilitacion, EinvoicingHabilitacionSchema } from './infrastructure/schemas/einvoicing-habilitacion.schema';
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
  PROVEEDOR_TRANSMISOR_NOMINA,
  ProveedorTransmisorNomina,
  ProveedorTransmisorPorEmisor,
} from './application/transmision-dian.puertos';
import { ReconsultaDianService } from './application/reconsulta-dian.service';
import { NotasColgadasBarrido } from './application/notas-colgadas.barrido';
import { NominaElectronicaService } from './application/nomina-electronica.service';
import { ArmadorUblFactura } from './application/armador-ubl';
import { DocumentoFeVistaService } from './application/documento-fe-vista.service';
import { RangosDianService } from './application/rangos-dian.service';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CoreParamsModule } from '../core-params/core-params.module';
import { EntregaDianService } from './application/entrega-dian.service';
import { EmisionDocumentoFiscalDian } from './application/emision-documento-fiscal.adaptador';
import { EMISION_DOCUMENTO_FISCAL } from '../sales/application/emision-documento-fiscal.puerto';
import { ENTREGA_DIAN } from './application/entrega-dian.puerto';
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
      { name: PayrollEDocument.name, schema: PayrollEDocumentSchema },
      { name: PayrollHabilitacion.name, schema: PayrollHabilitacionSchema },
      { name: EinvoicingHabilitacion.name, schema: EinvoicingHabilitacionSchema },
      { name: PayrollRun.name, schema: PayrollRunSchema },
      { name: PayrollDeduction.name, schema: PayrollDeductionSchema },
      { name: PayrollLiquidacion.name, schema: PayrollLiquidacionSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: FiscalEmitter.name, schema: FiscalEmitterSchema },
      { name: Sede.name, schema: SedeSchema },
    ]),
    SalesModule,
    EmployeesModule,
    SedesModule,
    ControlModule,
    StorageModule,
    CoreAuditModule,
    CoreAuthModule,
    CoreParamsModule,
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
    // Nómina electrónica: firma, persistencia y transmisión con credenciales de NÓMINA.
    NominaElectronicaService,
    NominaPeriodoService,
    HabilitacionNominaService,
    HabilitacionFacturaService,
    ReconsultaDianService,
    NotasColgadasBarrido,
    { provide: PROVEEDOR_TRANSMISOR_NOMINA, useClass: ProveedorTransmisorNomina },
    // Fase 5B: entrega al adquiriente (PDF + AttachedDocument/ZIP) tras `accepted`.
    EntregaDianService,
    DocumentoFeVistaService,
    RangosDianService,
    { provide: ENTREGA_DIAN, useExisting: EntregaDianService },
    // Fase 7 (PR 7B): el cobro pide el documento fiscal por este puerto. Ventas
    // lo resuelve con ModuleRef (este módulo ya importa SalesModule).
    { provide: EMISION_DOCUMENTO_FISCAL, useClass: EmisionDocumentoFiscalDian },
  ],
  exports: [
    EinvoicingService,
    FiscalEmittersService,
    CertificadoEmisorService,
    TransmisionDianService,
    NominaElectronicaService,
    ReconsultaDianService,
    NotasColgadasBarrido,
  ],
})
export class EinvoicingModule {}
