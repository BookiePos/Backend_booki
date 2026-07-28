import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { TaxService } from '../application/tax.service';
import {
  CreateTaxDto,
  SetTaxRateVersionDto,
  UpdateTaxDto,
} from '../application/dto/tax.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('taxes')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @RequirePermissions(PERMISSIONS.TAX_MANAGE)
  @Get()
  list() {
    return this.tax.list();
  }

  @RequirePermissions(PERMISSIONS.TAX_MANAGE)
  @Get('compute')
  compute(
    @Query('code') code: string,
    @Query('base') base: string,
    @Query('date') date?: string,
  ) {
    return this.tax.compute(code, Number.parseInt(base, 10) || 0, date);
  }

  @RequirePermissions(PERMISSIONS.TAX_MANAGE)
  @Post()
  create(@Body() dto: CreateTaxDto, @CurrentUser() user: JwtUser) {
    return this.tax.create(dto, user.email);
  }

  @RequirePermissions(PERMISSIONS.TAX_MANAGE)
  @Patch(':code')
  update(@Param('code') code: string, @Body() dto: UpdateTaxDto) {
    return this.tax.update(code, dto);
  }

  @RequirePermissions(PERMISSIONS.TAX_MANAGE)
  @Post(':code/versions')
  setVersion(
    @Param('code') code: string,
    @Body() dto: SetTaxRateVersionDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.tax.setVersion(code, dto, user.email);
  }
}
