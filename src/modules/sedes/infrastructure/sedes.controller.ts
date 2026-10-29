import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { SedesService } from '../application/sedes.service';
import { CreateSedeDto } from '../application/dto/create-sede.dto';
import { UpdateSedeDto } from '../application/dto/update-sede.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { NoPermissionRequired } from '../../core-auth/infrastructure/decorators/no-permission-required.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';

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

  // Avisos fiscales de las sedes del usuario (no cambian la venta). Mismo
  // alcance que el listado. Va antes de `:id/...` solo por claridad: las rutas
  // no chocan.
  @NoPermissionRequired()
  @Get('chequeo-fiscal')
  chequeoFiscal(@CurrentUser() user: JwtUser) {
    return this.sedes.chequeoFiscal(allowedSedeIds(user));
  }

  // Imagen del QR para mostrarla al cobrar: el listado no la trae. Mismo
  // criterio que el listado (sin permiso propio, solo sedes del usuario).
  @NoPermissionRequired()
  @Get(':id/cobro-digital')
  cobroDigital(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    assertSedeAccess(user, id);
    return this.sedes.cobroDigital(id);
  }

  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Post()
  create(@Body() dto: CreateSedeDto) {
    return this.sedes.create(dto);
  }

  // Editar exige además tener acceso a ESA sede: un Gerente de la sede A con
  // `sede.manage` no toca el nombre ni la resolución DIAN de la sede B.
  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSedeDto,
    @CurrentUser() user: JwtUser,
  ) {
    assertSedeAccess(user, id);
    return this.sedes.update(id, dto);
  }
}
