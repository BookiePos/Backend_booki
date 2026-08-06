import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { SedesService } from '../application/sedes.service';
import { CreateSedeDto } from '../application/dto/create-sede.dto';
import { UpdateSedeDto } from '../application/dto/update-sede.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { NoPermissionRequired } from '../../core-auth/infrastructure/decorators/no-permission-required.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { allowedSedeIds } from '../../core-auth/domain/sede-access';

@Controller('sedes')
export class SedesController {
  constructor(private readonly sedes: SedesService) {}

  // Listado transversal: lo consumen el POS y casi todas las pantallas de
  // back-office (finanzas, nómina, empleados, usuarios). No se exige un permiso
  // concreto porque el servicio ya restringe el resultado a las sedes asignadas
  // del usuario (allowedSedeIds); el Dueño / `sede.view_all` las ve todas. Sin
  // esto, un rol custom sin `pos.sell` recibiría 403 y esas pantallas quedarían
  // a medias. Solo devuelve nombres/datos de sede del propio tenant.
  @NoPermissionRequired()
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
