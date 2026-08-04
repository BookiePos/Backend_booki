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

  @RequirePermissions(PERMISSIONS.PAYROLL_VIEW)
  @Get('settings')
  getSettings() {
    return this.payroll.getSettings();
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_MANAGE)
  @Put('settings')
  updateSettings(@Body() dto: UpdatePayrollSettingsDto) {
    return this.payroll.updateSettings(dto);
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_VIEW)
  @Post('preview')
  preview(@Body() dto: PreviewPayrollDto) {
    return this.payroll.preview(dto);
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_VIEW)
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

  @RequirePermissions(PERMISSIONS.PAYROLL_VIEW)
  @Post('liquidacion')
  liquidacion(@Body() dto: LiquidacionDto) {
    return this.payroll.liquidacion(dto);
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_MANAGE)
  @Post('runs')
  createRun(@Body() dto: CreateRunDto, @CurrentUser() user: JwtUser) {
    return this.payroll.createRun(dto, user);
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_VIEW)
  @Get('runs')
  listRuns() {
    return this.payroll.listRuns();
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_VIEW)
  @Get('runs/:id')
  getRun(@Param('id') id: string) {
    return this.payroll.getRun(id);
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_MANAGE)
  @Post('runs/:id/close')
  closeRun(@Param('id') id: string) {
    return this.payroll.closeRun(id);
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_MANAGE)
  @Delete('runs/:id')
  async removeRun(@Param('id') id: string) {
    await this.payroll.removeRun(id);
    return { ok: true };
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_MANAGE)
  @Post('runs/:id/slips/:employeeId/send')
  sendSlip(
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.payroll.sendSlip(id, employeeId);
  }

  // ── Deducciones de empleado ─────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.PAYROLL_VIEW)
  @Get('deductions')
  listDeductions(
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: DeductionStatus,
  ) {
    return this.payroll.listDeductions({ employeeId, status });
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_MANAGE)
  @Post('deductions')
  createDeduction(
    @Body() dto: CreateDeductionDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.payroll.createDeduction(dto, user);
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_DEDUCTION_APPROVE)
  @Post('deductions/:id/approve')
  approveDeduction(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.payroll.approveDeduction(id, user);
  }

  @RequirePermissions(PERMISSIONS.PAYROLL_DEDUCTION_APPROVE)
  @Post('deductions/:id/reject')
  rejectDeduction(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.payroll.rejectDeduction(id, user);
  }
}
