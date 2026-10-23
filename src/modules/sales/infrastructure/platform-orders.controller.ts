import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PlatformOrdersService } from '../application/platform-orders.service';
import { PlatformSettlementsService } from '../application/platform-settlements.service';
import {
  CreatePlatformSettlementDto,
  ImportPlatformOrdersDto,
} from '../application/dto/platform-orders.dto';
import { PLATFORM_CODES, PlatformCode } from '../domain/platform-orders';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Pedidos de plataformas de domicilio (ítem 7.5). El registro manual de un
 * pedido NO tiene endpoint propio: es `POST /sales` con `payment.method =
 * 'platform'` y el dato `platform`.
 *
 * Importar pedidos es lo mismo que venderlos uno a uno, así que pide `pos.sell`.
 * El saldo y las liquidaciones tocan el libro: `finance.view` para leer y
 * `finance.manage` para liquidar o anular una liquidación.
 */
@Controller('platform-orders')
export class PlatformOrdersController {
  constructor(
    private readonly orders: PlatformOrdersService,
    private readonly settlements: PlatformSettlementsService,
  ) {}

  private platform(value?: string): PlatformCode | undefined {
    if (!value) return undefined;
    if (!(PLATFORM_CODES as readonly string[]).includes(value)) {
      throw new BadRequestException('Plataforma no válida');
    }
    return value as PlatformCode;
  }

  /** Vista previa del CSV: emparejamiento de productos, duplicados y errores por fila. No escribe. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post('import/preview')
  preview(@Body() dto: ImportPlatformOrdersDto, @CurrentUser() user: JwtUser) {
    return this.orders.preview(dto, user);
  }

  /** Crea las ventas del CSV. Idempotente por (plataforma, código del pedido). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post('import')
  import(@Body() dto: ImportPlatformOrdersDto, @CurrentUser() user: JwtUser) {
    return this.orders.import(dto, user);
  }

  /** Ventas por plataforma y saldo por cobrar a cada una. Antes de :id. */
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('summary')
  summary(
    @Query('sedeId') sedeId: string,
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    const fecha = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !fecha.test(from)) || (to && !fecha.test(to))) {
      throw new BadRequestException('Las fechas deben ser YYYY-MM-DD');
    }
    return this.orders.summary({ sedeId, from, to }, user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('settlements')
  listSettlements(
    @Query('sedeId') sedeId: string,
    @CurrentUser() user: JwtUser,
    @Query('platform') platform?: string,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.settlements.list({ sedeId, platform: this.platform(platform) }, user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('settlements')
  settle(@Body() dto: CreatePlatformSettlementDto, @CurrentUser() user: JwtUser) {
    return this.settlements.create(dto, user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('settlements/:id/void')
  voidSettlement(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.settlements.void(id, user);
  }

  /** Pedidos de plataforma de la sede (`pending=true`: lo que la plataforma aún debe). */
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get()
  list(
    @Query('sedeId') sedeId: string,
    @CurrentUser() user: JwtUser,
    @Query('platform') platform?: string,
    @Query('pending') pending?: string,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.orders.list(
      { sedeId, platform: this.platform(platform), pending: pending === 'true' },
      user,
    );
  }
}
