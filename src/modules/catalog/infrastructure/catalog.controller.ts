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
