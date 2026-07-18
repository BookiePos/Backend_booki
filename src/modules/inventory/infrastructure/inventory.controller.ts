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
import { ProductsService } from '../application/products.service';
import { StockService } from '../application/stock.service';
import { CreateProductDto } from '../application/dto/create-product.dto';
import { UpdateProductDto } from '../application/dto/update-product.dto';
import { CreateCategoryDto } from '../application/dto/create-category.dto';
import { StockEntryDto } from '../application/dto/stock-entry.dto';
import { StockAdjustDto } from '../application/dto/stock-adjust.dto';
import { StockTransferDto } from '../application/dto/stock-transfer.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly products: ProductsService,
    private readonly stock: StockService,
  ) {}

  // ─── Catálogo de productos ─────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('products')
  listProducts(@Query('includeInactive') includeInactive?: string) {
    return this.products.list(includeInactive === 'true');
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('products')
  createProduct(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  /** Elimina el producto y todo su historial (existencias, lotes, kardex). */
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Delete('products/:id')
  deleteProduct(@Param('id') id: string) {
    return this.stock.removeProduct(id);
  }

  // ─── Categorías ────────────────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('categories')
  listCategories() {
    return this.products.listCategories();
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.products.createCategory(dto);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() dto: CreateCategoryDto) {
    return this.products.updateCategory(id, dto);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    await this.products.deleteCategory(id);
    return { ok: true };
  }

  // ─── Existencias y lotes ───────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('stock')
  getStock(@Query('sedeId') sedeId?: string) {
    return this.stock.stock(sedeId);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('products/:id/lots')
  getLots(@Param('id') productId: string, @Query('sedeId') sedeId?: string) {
    return this.stock.lots(productId, sedeId);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('alerts')
  getAlerts(@Query('sedeId') sedeId?: string, @Query('days') days?: string) {
    const parsed = days ? Number.parseInt(days, 10) : undefined;
    return this.stock.alerts(
      sedeId,
      parsed && parsed > 0 ? parsed : undefined,
    );
  }

  // ─── Kardex ────────────────────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('movements')
  getMovements(
    @Query('sedeId') sedeId?: string,
    @Query('productId') productId?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.stock.movements({
      sedeId: sedeId || undefined,
      productId: productId || undefined,
      type: type || undefined,
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  // ─── Operaciones ───────────────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('entries')
  createEntry(@Body() dto: StockEntryDto, @CurrentUser() user: JwtUser) {
    return this.stock.entry(dto, user);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('adjustments')
  createAdjustment(@Body() dto: StockAdjustDto, @CurrentUser() user: JwtUser) {
    return this.stock.adjust(dto, user);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_TRANSFER)
  @Post('transfers')
  createTransfer(@Body() dto: StockTransferDto, @CurrentUser() user: JwtUser) {
    return this.stock.transfer(dto, user);
  }
}
