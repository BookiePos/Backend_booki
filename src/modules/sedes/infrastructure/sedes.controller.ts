import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { SedesService } from '../application/sedes.service';
import { CreateSedeDto } from '../application/dto/create-sede.dto';
import { UpdateSedeDto } from '../application/dto/update-sede.dto';
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

  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSedeDto) {
    return this.sedes.update(id, dto);
  }
}
