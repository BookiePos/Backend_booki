import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { DeliveriesService } from '../application/deliveries.service';
import { UpdateDeliveryStatusDto } from '../application/dto/delivery-status.dto';
import { DeliveryStatus } from '../domain/delivery.constants';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

/**
 * Seguimiento de domicilios: en qué va cada entrega y qué trae el repartidor.
 *
 * Todo va con `pos.sell`, que es el permiso del turno. Marcar que un pedido
 * salió o llegó es parte de atender, no de administrar: si pidiera un permiso
 * de dueño, nadie lo marcaría y la lista serviría para nada.
 */
@Controller('delivery/orders')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  /** Domicilios de la sede en un día (hoy por omisión). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get()
  list(
    @Query('sedeId') sedeId: string,
    @CurrentUser() user: JwtUser,
    @Query('date') date?: string,
    @Query('status') status?: DeliveryStatus,
  ) {
    return this.deliveries.list({ sedeId, date, status }, user);
  }

  /** Cuadre del turno: cuánta plata trae cada repartidor. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('settlement')
  settlement(
    @Query('sedeId') sedeId: string,
    @CurrentUser() user: JwtUser,
    @Query('date') date?: string,
  ) {
    return this.deliveries.settlement({ sedeId, date }, user);
  }

  /** Salió, llegó, o no se pudo entregar. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Patch(':saleId')
  updateStatus(
    @Param('saleId') saleId: string,
    @Body() dto: UpdateDeliveryStatusDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.deliveries.updateStatus(saleId, dto, user);
  }
}
