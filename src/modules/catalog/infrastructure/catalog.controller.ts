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
import { CatalogService } from '../application/catalog.service';
import { CreateCatalogProductDto } from '../application/dto/create-catalog-product.dto';
import { UpdateCatalogProductDto } from '../application/dto/update-catalog-product.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

/** Catálogo de productos vendibles del POS (ítem directo o receta). */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('products')
  list(@Query('includeInactive') includeInactive?: string) {
    return this.catalog.list(includeInactive === 'true');
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('products')
  create(@Body() dto: CreateCatalogProductDto) {
    return this.catalog.create(dto);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Patch('products/:id')
  update(@Param('id') id: string, @Body() dto: UpdateCatalogProductDto) {
    return this.catalog.update(id, dto);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Delete('products/:id')
  async remove(@Param('id') id: string) {
    await this.catalog.remove(id);
    return { ok: true };
  }
}
