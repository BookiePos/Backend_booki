import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { DeliveryZonesService } from '../application/delivery-zones.service';
import {
  CreateDeliveryZoneDto,
  UpdateDeliveryZoneDto,
} from '../application/dto/delivery-zone.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

/**
 * Zonas de domicilio con tarifa fija.
 *
 * Leerlas necesita `pos.sell` porque el terminal las carga para cobrar;
 * administrarlas va con `sede.manage`, que es el permiso de quien configura la
 * sede. Sin permisos nuevos, así que la lista que el frontend replica en
 * `access.ts` no queda desincronizada.
 */
@Controller('delivery/zones')
export class DeliveryController {
  constructor(private readonly zones: DeliveryZonesService) {}

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get()
  list(
    @Query('sedeId') sedeId: string,
    @CurrentUser() user: JwtUser,
    @Query('includeInactive') includeInactive?: string,
  ) {
    assertSedeAccess(user, sedeId);
    return this.zones.list(sedeId, includeInactive === 'true');
  }

  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Post()
  create(@Body() dto: CreateDeliveryZoneDto, @CurrentUser() user: JwtUser) {
    assertSedeAccess(user, dto.sedeId);
    return this.zones.create(dto);
  }

  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDeliveryZoneDto) {
    return this.zones.update(id, dto);
  }

  /** Se desactiva, no se borra: las ventas viejas guardan lo que se cobró. */
  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Delete(':id')
  deactivate(@Param('id') id: string) {
    return this.zones.deactivate(id);
  }
}
