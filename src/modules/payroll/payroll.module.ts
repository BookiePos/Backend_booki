import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  PayrollSettings,
  PayrollSettingsSchema,
} from './infrastructure/schemas/payroll-settings.schema';
import {
  PayrollRun,
  PayrollRunSchema,
} from './infrastructure/schemas/payroll-run.schema';
import {
  PayrollDeduction,
  PayrollDeductionSchema,
} from './infrastructure/schemas/payroll-deduction.schema';
import {
  Employee,
  EmployeeSchema,
} from '../employees/infrastructure/schemas/employee.schema';
import {
  AttendanceRecord,
  AttendanceRecordSchema,
} from '../attendance/infrastructure/schemas/attendance-record.schema';
import {
  Sede,
  SedeSchema,
} from '../sedes/infrastructure/schemas/sede.schema';
import {
  PayrollEDocument,
  PayrollEDocumentSchema,
} from '../einvoicing/infrastructure/schemas/payroll-e-document.schema';
import {
  PayrollLiquidacion,
  PayrollLiquidacionSchema,
} from './infrastructure/schemas/payroll-liquidacion.schema';
import { PayrollNovedad, PayrollNovedadSchema } from './infrastructure/schemas/payroll-novedad.schema';
import {
  PayrollPagoPrestacion,
  PayrollPagoPrestacionSchema,
} from './infrastructure/schemas/payroll-pago-prestacion.schema';
import { PagosPrestacionesService } from './application/pagos-prestaciones.service';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CoreParamsModule } from '../core-params/core-params.module';
import { CoreLedgerModule } from '../core-ledger/core-ledger.module';
import { PayrollService } from './application/payroll.service';
import { PayrollController } from './infrastructure/payroll.controller';

@Module({
  imports: [
    CoreAuthModule,
    CoreParamsModule,
    CoreLedgerModule,
    TenantMongooseModule.forFeature([
      { name: PayrollSettings.name, schema: PayrollSettingsSchema },
      { name: PayrollRun.name, schema: PayrollRunSchema },
      { name: PayrollDeduction.name, schema: PayrollDeductionSchema },
      { name: Employee.name, schema: EmployeeSchema },
      { name: AttendanceRecord.name, schema: AttendanceRecordSchema },
      { name: Sede.name, schema: SedeSchema },
      { name: PayrollEDocument.name, schema: PayrollEDocumentSchema },
      { name: PayrollLiquidacion.name, schema: PayrollLiquidacionSchema },
      { name: PayrollNovedad.name, schema: PayrollNovedadSchema },
      { name: PayrollPagoPrestacion.name, schema: PayrollPagoPrestacionSchema },
    ]),
  ],
  controllers: [PayrollController],
  providers: [PayrollService, PagosPrestacionesService],
  exports: [PayrollService],
})
export class PayrollModule {}
