import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PurchasingService } from '../application/purchasing.service';
import {
  CreatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from '../application/dto/purchasing.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { RequireFeature } from '../../core-auth/infrastructure/decorators/require-feature.decorator';
import { PLAN_FEATURES } from '../../control/domain/plans';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { PurchaseOrderStatus } from '../domain/purchasing.constants';

@RequireFeature(PLAN_FEATURES.PURCHASING)
@Controller('purchasing/orders')
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('status') status?: PurchaseOrderStatus,
  ) {
    return this.purchasing.list(user, { sedeId, status });
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.purchasing.get(id, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post()
  create(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: JwtUser) {
    return this.purchasing.create(dto, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.purchasing.update(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post(':id/send')
  send(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.purchasing.send(id, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.purchasing.cancel(id, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post(':id/receive')
  receive(
    @Param('id') id: string,
    @Body() dto: ReceivePurchaseOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.purchasing.receive(id, dto, user);
  }
}
