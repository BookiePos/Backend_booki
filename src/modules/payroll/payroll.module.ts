import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PayrollSettings,
  PayrollSettingsSchema,
} from './infrastructure/schemas/payroll-settings.schema';
import {
  PayrollRun,
  PayrollRunSchema,
} from './infrastructure/schemas/payroll-run.schema';
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
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { PayrollService } from './application/payroll.service';
import { PayrollController } from './infrastructure/payroll.controller';

@Module({
  imports: [
    CoreAuthModule,
    MongooseModule.forFeature([
      { name: PayrollSettings.name, schema: PayrollSettingsSchema },
      { name: PayrollRun.name, schema: PayrollRunSchema },
      { name: Employee.name, schema: EmployeeSchema },
      { name: AttendanceRecord.name, schema: AttendanceRecordSchema },
      { name: Sede.name, schema: SedeSchema },
    ]),
  ],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
