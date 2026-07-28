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
import { PayrollService } from './application/payroll.service';
import { PayrollController } from './infrastructure/payroll.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PayrollSettings.name, schema: PayrollSettingsSchema },
      { name: PayrollRun.name, schema: PayrollRunSchema },
      { name: Employee.name, schema: EmployeeSchema },
    ]),
  ],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
