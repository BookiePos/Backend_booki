import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PayrollService } from '../application/payroll.service';
import { UpdatePayrollSettingsDto } from '../application/dto/update-settings.dto';
import { PreviewPayrollDto } from '../application/dto/preview-payroll.dto';
import { CreateRunDto } from '../application/dto/create-run.dto';
import { CreateDeductionDto } from '../application/dto/deduction.dto';
import { LiquidacionDto } from '../application/dto/liquidacion.dto';
import { DeductionStatus } from '../infrastructure/schemas/payroll-deduction.schema';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('settings')
  getSettings() {
    return this.payroll.getSettings();
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Put('settings')
  updateSettings(@Body() dto: UpdatePayrollSettingsDto) {
    return this.payroll.updateSettings(dto);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('preview')
  preview(@Body() dto: PreviewPayrollDto) {
    return this.payroll.preview(dto);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('novedades-turnos')
  novedadesTurnos(
    @Query('employeeId') employeeId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    if (!employeeId || !from || !to) {
      throw new BadRequestException('employeeId, from y to son obligatorios');
    }
    return this.payroll.novedadesTurnos(employeeId, from, to);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('liquidacion')
  liquidacion(@Body() dto: LiquidacionDto) {
    return this.payroll.liquidacion(dto);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('runs')
  createRun(@Body() dto: CreateRunDto, @CurrentUser() user: JwtUser) {
    return this.payroll.createRun(dto, user);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('runs')
  listRuns() {
    return this.payroll.listRuns();
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('runs/:id')
  getRun(@Param('id') id: string) {
    return this.payroll.getRun(id);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Delete('runs/:id')
  async removeRun(@Param('id') id: string) {
    await this.payroll.removeRun(id);
    return { ok: true };
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('runs/:id/slips/:employeeId/send')
  sendSlip(
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.payroll.sendSlip(id, employeeId);
  }

  // ── Deducciones de empleado ─────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('deductions')
  listDeductions(
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: DeductionStatus,
  ) {
    return this.payroll.listDeductions({ employeeId, status });
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('deductions')
  createDeduction(
    @Body() dto: CreateDeductionDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.payroll.createDeduction(dto, user);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('deductions/:id/approve')
  approveDeduction(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.payroll.approveDeduction(id, user);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('deductions/:id/reject')
  rejectDeduction(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.payroll.rejectDeduction(id, user);
  }
}
