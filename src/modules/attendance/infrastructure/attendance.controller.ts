import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { AttendanceService } from '../application/attendance.service';
import { UpsertAttendanceDto } from '../application/dto/upsert-attendance.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  /** Trabajadores vinculados a la sede. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('workers')
  workers(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.attendance.workers(sedeId, user);
  }

  /**
   * Horas trabajadas por trabajador y sede en un rango (YYYY-MM-DD). Sin
   * `sedeId` agrega sobre todas las sedes que el usuario puede ver.
   */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('summary')
  summary(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('sedeId') sedeId: string | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    if (!from || !to) {
      throw new BadRequestException('from y to son obligatorios');
    }
    return this.attendance.summary(from, to, sedeId, user);
  }

  /** Registros de asistencia de una sede en un día (YYYY-MM-DD). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get()
  list(
    @Query('sedeId') sedeId: string,
    @Query('date') date: string,
    @CurrentUser() user: JwtUser,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    if (!date) throw new BadRequestException('date es obligatorio');
    return this.attendance.list(sedeId, date, user);
  }

  /** Registra/actualiza entrada y salida de un trabajador. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post()
  upsert(@Body() dto: UpsertAttendanceDto, @CurrentUser() user: JwtUser) {
    return this.attendance.upsert(dto, user);
  }
}
