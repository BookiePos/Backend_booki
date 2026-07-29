import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { EmployeesService } from '../application/employees.service';
import { CreateEmployeeDto } from '../application/dto/create-employee.dto';
import { UpdateEmployeeDto } from '../application/dto/update-employee.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get()
  list() {
    return this.employees.list();
  }

  // Selector liviano para el POS (fiado/consumo de empleado). Gated pos.sell.
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('lookup')
  lookup() {
    return this.employees.lookup();
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get(':id')
  get(@Param('id') id: string) {
    return this.employees.getOrFail(id);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post()
  create(@Body() dto: CreateEmployeeDto) {
    return this.employees.create(dto);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employees.update(id, dto);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.employees.remove(id);
    return { ok: true };
  }
}
