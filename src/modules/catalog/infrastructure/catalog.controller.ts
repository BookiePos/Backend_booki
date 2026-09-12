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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CatalogService,
  type UploadedImage,
} from '../application/catalog.service';
import { PRODUCT_IMAGE_MAX_BYTES } from '../domain/product-image';
import { CreateCatalogProductDto } from '../application/dto/create-catalog-product.dto';
import { UpdateCatalogProductDto } from '../application/dto/update-catalog-product.dto';
import { PriceListsService } from '../application/price-lists.service';
import {
  CreatePriceListDto,
  UpdatePriceListDto,
} from '../application/dto/price-list.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

/** Catálogo de productos vendibles del POS (ítem directo o receta). */
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly priceLists: PriceListsService,
  ) {}

  // ─── Listas de precios ─────────────────────────────────────────────────────
  // Leerlas necesita `pos.sell` porque el terminal las carga para cobrar;
  // editarlas va con `inventory.adjust`, el mismo permiso con el que se cambia
  // el precio de mostrador. Sin permisos nuevos, así que la lista que replica
  // el frontend en `access.ts` no queda desincronizada.

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('price-lists')
  listPriceLists(@Query('includeInactive') includeInactive?: string) {
    return this.priceLists.list(includeInactive === 'true');
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('price-lists')
  createPriceList(@Body() dto: CreatePriceListDto) {
    return this.priceLists.create(dto);
  }

  /** Cómo quedaría el catálogo con esta lista, para mostrarlo al configurar. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('price-lists/:id/preview')
  previewPriceList(@Param('id') id: string, @Query('qty') qty?: string) {
    const n = Number(qty);
    return this.priceLists.preview(id, Number.isFinite(n) && n > 0 ? n : 1);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Patch('price-lists/:id')
  updatePriceList(@Param('id') id: string, @Body() dto: UpdatePriceListDto) {
    return this.priceLists.update(id, dto);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Delete('price-lists/:id')
  deactivatePriceList(@Param('id') id: string) {
    return this.priceLists.deactivate(id);
  }

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

  /**
   * Sube o reemplaza la foto del producto (multipart, campo `file`).
   *
   * El límite de multer corta la subida mientras llega, sin llenar memoria con
   * un archivo que igual se iba a rechazar; el servicio revalida tamaño y
   * formato porque son reglas del catálogo, no del transporte.
   */
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Post('products/:id/image')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: PRODUCT_IMAGE_MAX_BYTES } }),
  )
  setImage(@Param('id') id: string, @UploadedFile() file?: UploadedImage) {
    if (!file) {
      throw new BadRequestException('Adjunta la imagen en el campo "file"');
    }
    return this.catalog.setImage(id, file);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Delete('products/:id/image')
  removeImage(@Param('id') id: string) {
    return this.catalog.removeImage(id);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @Delete('products/:id')
  async remove(@Param('id') id: string) {
    await this.catalog.remove(id);
    return { ok: true };
  }
}
