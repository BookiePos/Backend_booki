import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { SalesService } from '../application/sales.service';
import { CreateSaleDto } from '../application/dto/create-sale.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { SaleReturnsService } from '../application/sale-returns.service';
import { CreateSaleReturnDto } from '../application/dto/create-sale-return.dto';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('sales')
// Endpoints del POS: catálogo vendible, historial, venta y anulación.
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly returns: SaleReturnsService,
  ) {}

  /** Catálogo vendible con stock de la sede (antes de :id). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('pos-products')
  posProducts(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.sales.posProducts(sedeId, user);
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.sales.list(
      sedeId,
      user,
      page ? Number.parseInt(page, 10) : undefined,
      limit ? Number.parseInt(limit, 10) : undefined,
    );
  }

  /** Resumen de ventas de hoy (cantidad + total) de una sede. Antes de :id. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('stats')
  stats(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.sales.statsToday(sedeId, user);
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get(':id')
  get(@Param('id') id: string) {
    return this.sales.getOrFail(id);
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post()
  create(@Body() dto: CreateSaleDto, @CurrentUser() user: JwtUser) {
    return this.sales.create(dto, user);
  }

  /** Anula una venta y devuelve su consumo al inventario. */
  /**
   * Devolución PARCIAL: el cliente se llevó diez y trae dos.
   *
   * Va con `pos.refund` y no con el permiso de anular: son dos cosas distintas.
   * Anular borra la venta entera y suele ser un error de digitación; devolver
   * es atención al cliente, y el cajero del turno tiene que poder hacerlo sin
   * llamar al dueño.
   */
  @RequirePermissions(PERMISSIONS.POS_REFUND)
  @Post(':id/returns')
  createReturn(
    @Param('id') id: string,
    @Body() dto: CreateSaleReturnDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.returns.create(id, dto, user);
  }

  /** Lo que ya se devolvió de esta venta (para no devolver dos veces). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get(':id/returns')
  listReturns(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.returns.listForSale(id, user);
  }

  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Post(':id/void')
  void(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.sales.void(id, user);
  }
}
