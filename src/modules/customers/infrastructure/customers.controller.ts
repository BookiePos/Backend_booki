import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CustomersService } from '../application/customers.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
} from '../application/dto/customer.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequirePermissions(PERMISSIONS.CUSTOMERS_VIEW)
  @Get()
  list(
    @Query('search') search?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.customers.list({
      search,
      includeInactive: includeInactive === 'true',
    });
  }

  @RequirePermissions(PERMISSIONS.CUSTOMERS_VIEW)
  @Get(':id')
  get(@Param('id') id: string) {
    return this.customers.getOrFail(id);
  }

  @RequirePermissions(PERMISSIONS.CUSTOMERS_MANAGE)
  @Post()
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: JwtUser) {
    return this.customers.create(dto, user.email);
  }

  @RequirePermissions(PERMISSIONS.CUSTOMERS_MANAGE)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(id, dto);
  }
}
