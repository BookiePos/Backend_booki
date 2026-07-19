import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { SuppliersService } from '../application/suppliers.service';
import { CreateSupplierDto } from '../application/dto/create-supplier.dto';
import { UpdateSupplierDto } from '../application/dto/update-supplier.dto';
import { SetSupplierStatusDto } from '../application/dto/set-supplier-status.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get()
  list(@Query('includeInactive') includeInactive?: string) {
    return this.suppliers.list(includeInactive === 'true');
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post()
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetSupplierStatusDto) {
    return this.suppliers.setStatus(id, dto.active);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto);
  }
}
