import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { PayrollService } from '../application/payroll.service';
import { UpdatePayrollSettingsDto } from '../application/dto/update-settings.dto';
import { PreviewPayrollDto } from '../application/dto/preview-payroll.dto';
import { CreateRunDto } from '../application/dto/create-run.dto';
import { LiquidacionDto } from '../application/dto/liquidacion.dto';
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
}
