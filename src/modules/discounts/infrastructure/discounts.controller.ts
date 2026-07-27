import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { DiscountsService } from '../application/discounts.service';
import { CreateDiscountDto } from '../application/dto/create-discount.dto';
import { UpdateDiscountDto } from '../application/dto/update-discount.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('discounts')
export class DiscountsController {
  constructor(private readonly discounts: DiscountsService) {}

  /** Lista los descuentos de una sede (para el POS y la administración). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get()
  list(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.discounts.list(sedeId, user);
  }

  @RequirePermissions(PERMISSIONS.POS_DISCOUNT_AUTHORIZE)
  @Post()
  create(@Body() dto: CreateDiscountDto, @CurrentUser() user: JwtUser) {
    return this.discounts.create(dto, user);
  }

  @RequirePermissions(PERMISSIONS.POS_DISCOUNT_AUTHORIZE)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDiscountDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.discounts.update(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.POS_DISCOUNT_AUTHORIZE)
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.discounts.remove(id, user);
  }
}
