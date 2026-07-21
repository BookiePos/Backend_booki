import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { SedesService } from '../application/sedes.service';
import { CreateSedeDto } from '../application/dto/create-sede.dto';
import { UpdateSedeDto } from '../application/dto/update-sede.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { allowedSedeIds } from '../../core-auth/domain/sede-access';

@Controller('sedes')
export class SedesController {
  constructor(private readonly sedes: SedesService) {}

  // Cada usuario ve solo sus sedes asignadas; el Dueño (o quien tenga
  // `sede.view_all`) las ve todas.
  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.sedes.list(allowedSedeIds(user));
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
