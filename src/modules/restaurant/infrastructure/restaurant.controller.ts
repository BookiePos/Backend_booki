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
import { RestaurantService } from '../application/restaurant.service';
import {
  AddItemsDto,
  CancelOrderDto,
  CreateTableDto,
  OpenOrderDto,
  SetTipDto,
  UpdateTableDto,
} from '../application/dto/restaurant.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('restaurant')
export class RestaurantController {
  constructor(private readonly restaurant: RestaurantService) {}

  // ── Mesas ──────────────────────────────────────────────────────────────────
  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Get('tables')
  listTables(@CurrentUser() user: JwtUser, @Query('sedeId') sedeId?: string) {
    return this.restaurant.listTables(user, sedeId);
  }

  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Post('tables')
  createTable(@Body() dto: CreateTableDto, @CurrentUser() user: JwtUser) {
    return this.restaurant.createTable(dto, user);
  }

  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Patch('tables/:id')
  updateTable(
    @Param('id') id: string,
    @Body() dto: UpdateTableDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.restaurant.updateTable(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.SEDE_MANAGE)
  @Delete('tables/:id')
  deleteTable(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.restaurant.deleteTable(id, user);
  }

  // ── Comandas ────────────────────────────────────────────────────────────────
  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Get('orders')
  listOrders(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('status') status?: string,
  ) {
    return this.restaurant.listOrders(user, { sedeId, status });
  }

  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Get('orders/:id')
  getOrder(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.restaurant.getOrder(id, user);
  }

  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Post('orders')
  openOrder(@Body() dto: OpenOrderDto, @CurrentUser() user: JwtUser) {
    return this.restaurant.openOrder(dto, user);
  }

  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Post('orders/:id/items')
  addItems(
    @Param('id') id: string,
    @Body() dto: AddItemsDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.restaurant.addItems(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Delete('orders/:id/items/:itemId')
  removeItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.restaurant.removeItem(id, itemId, user);
  }

  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Post('orders/:id/send')
  sendToKitchen(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.restaurant.sendToKitchen(id, user);
  }

  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Post('orders/:id/bill')
  requestBill(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.restaurant.requestBill(id, user);
  }

  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Post('orders/:id/tip')
  setTip(
    @Param('id') id: string,
    @Body() dto: SetTipDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.restaurant.setTip(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Post('orders/:id/send-to-caja')
  sendToCaja(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.restaurant.sendToCaja(id, user);
  }

  @RequirePermissions(PERMISSIONS.RESTAURANT_OPERATE)
  @Post('orders/:id/close')
  closeOrder(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.restaurant.closeOrder(id, user);
  }

  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Post('orders/:id/cancel')
  cancelOrder(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.restaurant.cancelOrder(id, dto, user);
  }
}
