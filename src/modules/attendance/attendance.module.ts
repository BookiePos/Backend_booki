import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AttendanceRecord,
  AttendanceRecordSchema,
} from './infrastructure/schemas/attendance-record.schema';
import {
  Employee,
  EmployeeSchema,
} from '../employees/infrastructure/schemas/employee.schema';
import {
  Sede,
  SedeSchema,
} from '../sedes/infrastructure/schemas/sede.schema';
import { AttendanceService } from './application/attendance.service';
import { AttendanceController } from './infrastructure/attendance.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AttendanceRecord.name, schema: AttendanceRecordSchema },
      { name: Employee.name, schema: EmployeeSchema },
      { name: Sede.name, schema: SedeSchema },
    ]),
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
