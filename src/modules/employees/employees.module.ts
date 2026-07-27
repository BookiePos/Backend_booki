import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Employee,
  EmployeeSchema,
} from './infrastructure/schemas/employee.schema';
import {
  Position,
  PositionSchema,
} from './infrastructure/schemas/position.schema';
import { EmployeesService } from './application/employees.service';
import { PositionsService } from './application/positions.service';
import { EmployeesController } from './infrastructure/employees.controller';
import { PositionsController } from './infrastructure/positions.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Employee.name, schema: EmployeeSchema },
      { name: Position.name, schema: PositionSchema },
    ]),
  ],
  controllers: [EmployeesController, PositionsController],
  providers: [EmployeesService, PositionsService],
  exports: [EmployeesService, PositionsService],
})
export class EmployeesModule {}
