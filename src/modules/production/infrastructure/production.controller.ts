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
import { ProductionService } from '../application/production.service';
import {
  CompleteProductionOrderDto,
  CreateBomDto,
  CreateProductionOrderDto,
  PublishOutputDto,
  UpdateBomDto,
  UpdateProductionOrderDto,
} from '../application/dto/production.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  PRODUCTION_ORDER_STATUSES,
  ProductionOrderStatus,
} from '../domain/production.constants';

@Controller('production')
export class ProductionController {
  constructor(private readonly production: ProductionService) {}

  // ─── Recetas de lote ───────────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.PRODUCTION_VIEW)
  @Get('boms')
  listBoms(@Query('includeInactive') includeInactive?: string) {
    return this.production.listBoms(includeInactive === 'true');
  }

  @RequirePermissions(PERMISSIONS.PRODUCTION_VIEW)
  @Get('boms/:id')
  getBom(@Param('id') id: string) {
    return this.production.getBom(id);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTION_MANAGE)
  @Post('boms')
  createBom(@Body() dto: CreateBomDto) {
    return this.production.createBom(dto);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTION_MANAGE)
  @Patch('boms/:id')
  updateBom(@Param('id') id: string, @Body() dto: UpdateBomDto) {
    return this.production.updateBom(id, dto);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTION_MANAGE)
  @Delete('boms/:id')
  async deleteBom(@Param('id') id: string) {
    await this.production.removeBom(id);
    return { ok: true };
  }

  // ─── Puente con Inventario y Productos ─────────────────────────────────────

  /**
   * Terminados: qué se fabrica, cuánto hay en bodega, cuánto cuesta producirlo
   * y a qué precio se está vendiendo. Es la vista que une los tres módulos.
   */
  @RequirePermissions(PERMISSIONS.PRODUCTION_VIEW)
  @Get('outputs')
  listOutputs(@CurrentUser() user: JwtUser, @Query('sedeId') sedeId?: string) {
    return this.production.outputs(user, sedeId || undefined);
  }

  /** Publica el terminado en el catálogo del POS (lo deja vendible). */
  @RequirePermissions(PERMISSIONS.PRODUCTION_MANAGE)
  @Post('boms/:id/publish')
  publishOutput(@Param('id') id: string, @Body() dto: PublishOutputDto) {
    return this.production.publish(id, dto);
  }

  // ─── Órdenes de producción ─────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.PRODUCTION_VIEW)
  @Get('orders')
  listOrders(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('status') status?: string,
  ) {
    return this.production.list(user, {
      sedeId: sedeId || undefined,
      status: PRODUCTION_ORDER_STATUSES.includes(
        status as ProductionOrderStatus,
      )
        ? (status as ProductionOrderStatus)
        : undefined,
    });
  }

  @RequirePermissions(PERMISSIONS.PRODUCTION_VIEW)
  @Get('orders/:id')
  getOrder(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.production.get(id, user);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTION_MANAGE)
  @Post('orders')
  createOrder(
    @Body() dto: CreateProductionOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.production.create(dto, user);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTION_MANAGE)
  @Patch('orders/:id')
  updateOrder(
    @Param('id') id: string,
    @Body() dto: UpdateProductionOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.production.update(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTION_MANAGE)
  @Post('orders/:id/start')
  startOrder(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.production.start(id, user);
  }

  /**
   * Cierra la orden. Consume insumos e ingresa el terminado, así que exige
   * `production.manage`: no basta con poder mirar el tablero para mover stock.
   */
  @RequirePermissions(PERMISSIONS.PRODUCTION_MANAGE)
  @Post('orders/:id/complete')
  completeOrder(
    @Param('id') id: string,
    @Body() dto: CompleteProductionOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.production.complete(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTION_MANAGE)
  @Post('orders/:id/cancel')
  cancelOrder(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.production.cancel(id, user);
  }
}
