import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { OrdersService } from '../application/orders.service';
import { CreateOrderDto } from '../application/dto/create-order.dto';
import { UpdateOrderDto } from '../application/dto/update-order.dto';
import { CheckoutOrderDto } from '../application/dto/checkout-order.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { ORDER_STATUSES, OrderStatus } from '../domain/order.constants';

@Controller('orders')
// Cuentas abiertas del POS: abrir, editar, liquidar (cobrar) y anular.
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId: string,
    @Query('status') status?: string,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    const st: OrderStatus = ORDER_STATUSES.includes(status as OrderStatus)
      ? (status as OrderStatus)
      : 'open';
    return this.orders.list(sedeId, user, st);
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.getOrFail(id);
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post()
  open(@Body() dto: CreateOrderDto, @CurrentUser() user: JwtUser) {
    return this.orders.open(dto, user);
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.orders.update(id, dto, user);
  }

  /** Liquida la cuenta: crea la venta y descuenta inventario. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post(':id/checkout')
  checkout(
    @Param('id') id: string,
    @Body() dto: CheckoutOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.orders.checkout(id, dto, user);
  }

  /** Cierra la cuenta sin cobrar. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post(':id/void')
  void(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.orders.void(id, user);
  }
}
