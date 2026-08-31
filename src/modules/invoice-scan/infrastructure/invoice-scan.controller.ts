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
  InvoiceScanService,
  type UploadedInvoiceImage,
} from '../application/invoice-scan.service';
import {
  MergeInvoiceScanDto,
  SplitInvoiceScanDto,
  UpdateInvoiceScanDto,
} from '../application/dto/invoice-scan.dto';
import {
  INVOICE_IMAGE_MAX_BYTES,
  INVOICE_SCAN_STATUSES,
  InvoiceScanStatus,
} from '../domain/invoice-scan.constants';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { RequireFeature } from '../../core-auth/infrastructure/decorators/require-feature.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { PLAN_FEATURES } from '../../control/domain/plans';

/**
 * Facturas de compra cargadas por foto.
 *
 * Va bajo la capacidad `purchasing` del plan —quien no compra a proveedores no
 * necesita esto— y el control de costo lo hace la cuota mensual de escaneos,
 * no una capacidad aparte.
 */
@RequireFeature(PLAN_FEATURES.PURCHASING)
@Controller('invoice-scans')
export class InvoiceScanController {
  constructor(private readonly scans: InvoiceScanService) {}

  /** Historial del módulo: todas las facturas escaneadas, la última primero. */
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get()
  list(@Query('status') status?: string) {
    // Un estado desconocido en la query se ignora en vez de dar error: es un
    // filtro de listado, no una operación que deba fallar.
    const known = (INVOICE_SCAN_STATUSES as readonly string[]).includes(
      status ?? '',
    );
    return this.scans.list(known ? (status as InvoiceScanStatus) : undefined);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get(':id')
  get(@Param('id') id: string) {
    return this.scans.getOrFail(id);
  }

  /**
   * Sube una foto (multipart, campo `file`). **Una imagen por petición**: el
   * cuerpo máximo de una función de Vercel es 4.5 MB, así que varias fotos se
   * suben en varias llamadas y el cliente muestra el progreso.
   */
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: INVOICE_IMAGE_MAX_BYTES } }),
  )
  upload(
    @UploadedFile() file: UploadedInvoiceImage | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    if (!file) {
      throw new BadRequestException('Adjunta la imagen en el campo "file"');
    }
    return this.scans.upload(file, user);
  }

  /** Lee la factura con el modelo. Se puede reintentar si falla. */
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post(':id/extract')
  extract(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.scans.extract(id, user);
  }

  /** Guarda las correcciones de la revisión. */
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceScanDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.scans.update(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post(':id/merge')
  merge(
    @Param('id') id: string,
    @Body() dto: MergeInvoiceScanDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.scans.merge(id, dto.sourceId, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post(':id/split')
  split(
    @Param('id') id: string,
    @Body() dto: SplitInvoiceScanDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.scans.split(id, dto.pageIndex, user);
  }

  /** Aplica la factura aprobada: inventario, gastos, CxP y proveedor. */
  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post(':id/apply')
  apply(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.scans.apply(id, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Delete(':id')
  async discard(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    await this.scans.discard(id, user);
    return { ok: true };
  }
}
