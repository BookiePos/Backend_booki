import { Body, Controller, Get, Post } from '@nestjs/common';
import { SedesService } from '../application/sedes.service';
import { CreateSedeDto } from '../application/dto/create-sede.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

@Controller('sedes')
export class SedesController {
  constructor(private readonly sedes: SedesService) {}

  // Cualquier usuario autenticado puede listar sus sedes.
  @Get()
  list() {
    return this.sedes.list();
  }

  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Post()
  create(@Body() dto: CreateSedeDto) {
    return this.sedes.create(dto);
  }
}
