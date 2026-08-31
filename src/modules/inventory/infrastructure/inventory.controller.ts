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
import { CreateProductVariantsDto } from '../application/dto/create-product-variants.dto';
import { UpdateProductDto } from '../application/dto/update-product.dto';
import { CreateCategoryDto } from '../application/dto/create-category.dto';
import { ImportProductsDto } from '../application/dto/import-products.dto';
import { ImportStockDto } from '../application/dto/import-stock.dto';
import { StockEntryDto } from '../application/dto/stock-entry.dto';
import { StockAdjustDto } from '../application/dto/stock-adjust.dto';
import { StockTransferDto } from '../application/dto/stock-transfer.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { RequireFeature } from '../../core-auth/infrastructure/decorators/require-feature.decorator';
import { PLAN_FEATURES } from '../../control/domain/plans';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';

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

  /** Crea un producto con variantes (padre + una fila por combinación). */
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('products/with-variants')
  createProductWithVariants(@Body() dto: CreateProductVariantsDto) {
    return this.products.createWithVariants(dto);
  }

  /** Importación masiva (upsert por SKU) desde filas de un CSV. */
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('products/import')
  importProducts(@Body() dto: ImportProductsDto) {
    return this.products.importProducts(dto.rows);
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
  getStock(@CurrentUser() user: JwtUser, @Query('sedeId') sedeId?: string) {
    if (sedeId) assertSedeAccess(user, sedeId);
    return this.stock.stock(sedeId, allowedSedeIds(user));
  }

  /**
   * Lotes abiertos de todo el inventario (con filtros). Alimenta la pestaña
   * "Lotes" del panel. Va ANTES de `products/:id/lots` a propósito: son rutas
   * distintas, pero mantener juntas las de lotes evita que la siguiente se
   * cuele en medio.
   */
  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('lots')
  listLots(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('productId') productId?: string,
    @Query('status') status?: string,
    @Query('days') days?: string,
  ) {
    if (sedeId) assertSedeAccess(user, sedeId);
    const parsedDays = days ? Number.parseInt(days, 10) : undefined;
    const allowed = ['all', 'expired', 'expiring', 'ok'] as const;
    const parsedStatus = allowed.includes(status as (typeof allowed)[number])
      ? (status as (typeof allowed)[number])
      : 'all';
    return this.stock.allLots({
      sedeId: sedeId || undefined,
      productId: productId || undefined,
      status: parsedStatus,
      days: parsedDays && parsedDays > 0 ? parsedDays : undefined,
      restrict: allowedSedeIds(user),
    });
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('products/:id/lots')
  getLots(
    @Param('id') productId: string,
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
  ) {
    if (sedeId) assertSedeAccess(user, sedeId);
    return this.stock.lots(productId, sedeId, allowedSedeIds(user));
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('alerts')
  getAlerts(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('days') days?: string,
  ) {
    if (sedeId) assertSedeAccess(user, sedeId);
    const parsed = days ? Number.parseInt(days, 10) : undefined;
    return this.stock.alerts(
      sedeId,
      parsed && parsed > 0 ? parsed : undefined,
      allowedSedeIds(user),
    );
  }

  // ─── Kardex ────────────────────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('movements')
  getMovements(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('productId') productId?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (sedeId) assertSedeAccess(user, sedeId);
    return this.stock.movements({
      sedeId: sedeId || undefined,
      productId: productId || undefined,
      type: type || undefined,
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      restrict: allowedSedeIds(user),
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
  @RequireFeature(PLAN_FEATURES.TRANSFERS)
  @Post('transfers')
  createTransfer(@Body() dto: StockTransferDto, @CurrentUser() user: JwtUser) {
    return this.stock.transfer(dto, user);
  }

  /** Carga masiva de existencias (una entrada por fila) desde un CSV. */
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('stock/import')
  importStock(@Body() dto: ImportStockDto, @CurrentUser() user: JwtUser) {
    return this.stock.importStock(dto.rows, user);
  }
}
