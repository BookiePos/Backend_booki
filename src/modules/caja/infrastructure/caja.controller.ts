import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { CajaService } from '../application/caja.service';
import { OpenCajaDto } from '../application/dto/open-caja.dto';
import { CloseCajaDto } from '../application/dto/close-caja.dto';
import { CajaMovementDto } from '../application/dto/caja-movement.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('caja')
export class CajaController {
  constructor(private readonly caja: CajaService) {}

  /** Estado actual de la caja de la sede. Cualquier cajero puede consultarlo. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('current')
  current(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.caja.current(sedeId, user);
  }

  /** Resumen del día de todas las cajas visibles (panel del ERP). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('overview')
  overview(@CurrentUser() user: JwtUser, @Query('date') date?: string) {
    return this.caja.overview(user, date);
  }

  /** Cierres de caja (arqueos) de las sedes visibles en un rango de fechas. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('closings')
  closings(
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.caja.closings(user, { from, to });
  }

  /** Historial de turnos de la sede. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('sessions')
  history(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.caja.history(
      sedeId,
      user,
      page ? Number.parseInt(page, 10) : undefined,
      limit ? Number.parseInt(limit, 10) : undefined,
    );
  }

  @RequirePermissions(PERMISSIONS.CAJA_OPEN)
  @Post('open')
  open(@Body() dto: OpenCajaDto, @CurrentUser() user: JwtUser) {
    return this.caja.open(dto, user);
  }

  @RequirePermissions(PERMISSIONS.CAJA_CLOSE)
  @Post('close')
  close(@Body() dto: CloseCajaDto, @CurrentUser() user: JwtUser) {
    return this.caja.close(dto, user);
  }

  @RequirePermissions(PERMISSIONS.CAJA_MOVEMENT)
  @Post('movements')
  movement(@Body() dto: CajaMovementDto, @CurrentUser() user: JwtUser) {
    return this.caja.movement(dto, user);
  }
}
