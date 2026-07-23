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
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('sales')
// Endpoints del POS: catálogo vendible, historial, venta y anulación.
export class SalesController {
  constructor(private readonly sales: SalesService) {}

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
  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Post(':id/void')
  void(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.sales.void(id, user);
  }
}
