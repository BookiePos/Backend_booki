import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AttendanceService } from '../application/attendance.service';
import { UpsertAttendanceDto } from '../application/dto/upsert-attendance.dto';
import { AdminSetAttendanceDto } from '../application/dto/admin-set-attendance.dto';
import {
  CreateEditRequestDto,
  ResolveEditRequestDto,
} from '../application/dto/edit-request.dto';
import { EditRequestStatus } from '../infrastructure/schemas/attendance-edit-request.schema';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  /** Trabajadores vinculados a la sede. */
  @RequirePermissions(PERMISSIONS.ATTENDANCE_MANAGE)
  @Get('workers')
  workers(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.attendance.workers(sedeId, user);
  }

  /**
   * Horas trabajadas por trabajador y sede en un rango (YYYY-MM-DD). Sin
   * `sedeId` agrega sobre todas las sedes que el usuario puede ver.
   */
  @RequirePermissions(PERMISSIONS.ATTENDANCE_MANAGE)
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
  @RequirePermissions(PERMISSIONS.ATTENDANCE_MANAGE)
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

  /** Registra/actualiza entrada y salida de un trabajador (write-once, POS). */
  @RequirePermissions(PERMISSIONS.ATTENDANCE_MANAGE)
  @Post()
  upsert(@Body() dto: UpsertAttendanceDto, @CurrentUser() user: JwtUser) {
    return this.attendance.upsert(dto, user);
  }

  /**
   * Fija/corrige las horas desde Operación (sin write-once). Requiere el
   * permiso de gestión de empleados, no solo el de asistencia.
   */
  @RequirePermissions(PERMISSIONS.EMPLOYEES_MANAGE)
  @Post('admin')
  adminSet(@Body() dto: AdminSetAttendanceDto, @CurrentUser() user: JwtUser) {
    return this.attendance.adminSet(dto, user);
  }

  // ── Solicitudes de edición ──────────────────────────────────────────────────

  /** El trabajador solicita corregir sus horas ya registradas (desde el POS). */
  @RequirePermissions(PERMISSIONS.ATTENDANCE_MANAGE)
  @Post('requests')
  requestEdit(
    @Body() dto: CreateEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.attendance.requestEdit(dto, user);
  }

  /** Lista de solicitudes de edición (Operación); filtra por estado y sede. */
  @RequirePermissions(PERMISSIONS.EMPLOYEES_MANAGE)
  @Get('requests')
  listRequests(
    @Query('status') status: EditRequestStatus | undefined,
    @Query('sedeId') sedeId: string | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    return this.attendance.listRequests({ status, sedeId }, user);
  }

  /** Aprueba o rechaza una solicitud de edición (Operación). */
  @RequirePermissions(PERMISSIONS.EMPLOYEES_MANAGE)
  @Post('requests/:id/resolve')
  resolveRequest(
    @Param('id') id: string,
    @Body() dto: ResolveEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.attendance.resolveRequest(id, dto, user);
  }
}
