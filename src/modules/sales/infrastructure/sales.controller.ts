import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { SalesService } from '../application/sales.service';
import { PackagingService } from '../application/packaging.service';
import { CreateSaleDto } from '../application/dto/create-sale.dto';
import { PackagingSuggestionDto } from '../application/dto/packaging-suggestion.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { SaleReturnsService } from '../application/sale-returns.service';
import { CreateSaleReturnDto } from '../application/dto/create-sale-return.dto';
import {
  CreateNotaSinReferenciaDto,
  CreateSaleRebateDto,
} from '../application/dto/create-sale-rebate.dto';
import { NotasSinReferenciaService } from '../application/notas-sin-referencia.service';
import { SaldoFavorService } from '../application/saldo-favor.service';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { allowedSedeIds } from '../../core-auth/domain/sede-access';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { OfflineSalesService } from '../application/offline-sales.service';
import { DocumentoFiscalVentaService } from '../application/documento-fiscal-venta.service';
import { ContingenciaVentasService } from '../application/contingencia-ventas.service';
import { TranscribirContingenciaDto } from '../application/dto/transcribir-contingencia.dto';
import {
  ReserveOfflineNumbersDto,
  SyncOfflineSaleDto,
} from '../application/dto/offline-sale.dto';

@Controller('sales')
// Endpoints del POS: catálogo vendible, historial, venta y anulación.
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly returns: SaleReturnsService,
    private readonly packaging: PackagingService,
    private readonly offline: OfflineSalesService,
    private readonly documentoFiscal: DocumentoFiscalVentaService,
    private readonly sinReferencia: NotasSinReferenciaService,
    private readonly saldoFavor: SaldoFavorService,
    private readonly contingencia: ContingenciaVentasService,
  ) {}

  /**
   * Modo sin conexión (ítem 6.3): bloque de consecutivos de contingencia para
   * el turno abierto. Mismo permiso que vender: es para poder seguir vendiendo.
   * Antes de `:id`.
   */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post('offline/reservations')
  reserveOffline(
    @Body() dto: ReserveOfflineNumbersDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.offline.reserve(dto, user);
  }

  /** Traza de la serie de contingencia de la sede (qué se reservó y usó). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('offline/reservations')
  listOfflineReservations(
    @Query('sedeId') sedeId: string,
    @CurrentUser() user: JwtUser,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.offline.listReservations(sedeId, user);
  }

  /**
   * Bandeja de conflictos offline de la sede guardada en el servidor. La ve
   * quien autoriza anulaciones: es quien puede registrarlas con lo cobrado.
   */
  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Get('offline/conflicts')
  listOfflineConflicts(
    @Query('sedeId') sedeId: string,
    @CurrentUser() user: JwtUser,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.offline.listConflicts(sedeId, user);
  }

  /**
   * Faltantes de stock de ventas offline autorizadas sin regularizar en la
   * sede (costeados al último costo contra la puente 143595).
   */
  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Get('offline/faltantes')
  listOfflineFaltantes(
    @Query('sedeId') sedeId: string,
    @CurrentUser() user: JwtUser,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.offline.listFaltantes(sedeId, user);
  }

  /** Saca del stock lo que faltaba (ya entró) y cierra la cuenta puente. */
  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Post('offline/faltantes/:saleId/regularizar')
  regularizarOfflineFaltantes(
    @Param('saleId') saleId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.offline.regularizarFaltantes(saleId, user);
  }

  /**
   * Registra una venta cobrada sin conexión. Idempotente por `offlineId`:
   * reenviarla devuelve la misma venta (`status: 'duplicada'`).
   */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post('offline/sync')
  syncOffline(@Body() dto: SyncOfflineSaleDto, @CurrentUser() user: JwtUser) {
    return this.offline.sync(dto, user);
  }

  /** Catálogo vendible con stock de la sede (antes de :id). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('pos-products')
  posProducts(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.sales.posProducts(sedeId, user);
  }

  /**
   * Con qué empaque suele salir este carrito. Solo lee (POST por el tamaño del
   * cuerpo, no porque escriba): lo llama el POS al abrir la pantalla de cobro
   * para dejar la lista ya marcada.
   */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post('packaging-suggestion')
  packagingSuggestion(
    @Body() dto: PackagingSuggestionDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.packaging.sugerir(dto.sedeId, dto.lines, user);
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.sales.list(
      sedeId,
      user,
      page ? Number.parseInt(page, 10) : undefined,
      limit ? Number.parseInt(limit, 10) : undefined,
    );
  }

  /** Resumen de ventas de hoy (cantidad + total) de una sede. Antes de :id. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('stats')
  stats(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.sales.statsToday(sedeId, user);
  }

  /**
   * (Antes de `:id`.) Reporte de la 2805 por tercero (Fase 6C): saldo a favor de cada cliente,
   * lo que dice su auxiliar, lo que quedó sin tercero y el mayor de la 2805.
   */
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('saldos-favor')
  saldosFavor(@CurrentUser() user: JwtUser) {
    // El saldo a favor es de TODA la empresa: el cliente lo gasta en cualquier
    // sede, aunque cada asiento de la 2805 lleve la sede donde se originó. Por
    // eso no se filtra por sede y quien está limitado a unas sedes no lo ve.
    if (allowedSedeIds(user) !== null) {
      throw new ForbiddenException('El reporte de saldos a favor es de toda la empresa: no está disponible para un usuario limitado por sede.');
    }
    return this.saldoFavor.reporte();
  }

  /** Saldo a favor disponible de un cliente: el POS lo muestra antes de cobrar. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get('saldos-favor/:customerId')
  async saldoFavorDe(@Param('customerId') customerId: string) {
    return { customerId, saldo: await this.saldoFavor.saldoDe(customerId) };
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.sales.getForUser(id, user);
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post()
  async create(@Body() dto: CreateSaleDto, @CurrentUser() user: JwtUser) {
    const sale = await this.sales.create(dto, user);
    // Venta directa: el documento fiscal se pide con la venta ya confirmada.
    // Emitirlo va implícito en `pos.sell` (no pide `einvoicing.issue`): es el
    // documento obligatorio de ESTA venta (art. 16 Res. 165/2023), no una
    // emisión libre. Nunca lanza; el resultado viaja en `sale.documentoFiscal`.
    return this.documentoFiscal.alCobrar(sale, dto.documentoFiscal, user);
  }

  /** Anula una venta y devuelve su consumo al inventario. */
  /**
   * Devolución PARCIAL: el cliente se llevó diez y trae dos.
   *
   * Va con `pos.refund` y no con el permiso de anular: son dos cosas distintas.
   * Anular borra la venta entera y suele ser un error de digitación; devolver
   * es atención al cliente, y el cajero del turno tiene que poder hacerlo sin
   * llamar al dueño.
   */
  @RequirePermissions(PERMISSIONS.POS_REFUND)
  @Post(':id/returns')
  createReturn(
    @Param('id') id: string,
    @Body() dto: CreateSaleReturnDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.returns.create(id, dto, user);
  }

  /**
   * Completa a mano una devolución que quedó a medias (N2): stock, caja o
   * libro fallaron y no hay llave con qué reintentarla desde la caja. Mismo
   * permiso que registrar la devolución. Idempotente; 409 si otra petición la
   * está completando.
   */
  @RequirePermissions(PERMISSIONS.POS_REFUND)
  @Post('returns/:id/completar')
  completarDevolucion(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.returns.completarPendiente(id, user);
  }

  /**
   * Transcripción de contingencia (Fase 9): la venta hecha sin conexión o en
   * talonario recibe su POS 07 / FEV 03 y, en orden, las notas de lo que le
   * pasó mientras tanto; después se transmite. Es emitir un documento
   * electrónico: mismo permiso que la emisión (`einvoicing.issue`). El
   * servicio comprueba el acceso a la sede; idempotente por venta.
   */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Post(':id/contingencia/transcribir')
  transcribirContingencia(
    @Param('id') id: string,
    @Body() dto: TranscribirContingenciaDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.contingencia.transcribir(id, user, {
      talonario: dto.talonario,
      superadaAt: dto.superadaAt ? new Date(dto.superadaAt) : undefined,
    });
  }

  /**
   * Rebaja o descuento POSTERIOR sobre la venta (Fase 6C): menor valor sin que
   * vuelva mercancía, con su NC 91 o nota de ajuste 94 (conceptos 3–6).
   *
   * Va con el permiso de autorizar anulaciones y no con el de devolver: en la
   * devolución la mercancía vuelve y se cuenta; aquí sale plata (o baja la
   * cartera) sin nada físico que lo respalde, y eso lo autoriza un supervisor.
   */
  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Post(':id/rebajas')
  createRebaja(
    @Param('id') id: string,
    @Body() dto: CreateSaleRebateDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.returns.createRebaja(id, dto, user);
  }

  /**
   * Descuento SIN referencia (Fase 6C, NC 22 de la FEV): volumen o pronto
   * pago sobre las facturas de un cliente en un periodo. Mismo permiso que la
   * rebaja, por la misma razón.
   */
  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Post('rebajas/sin-referencia')
  createSinReferencia(@Body() dto: CreateNotaSinReferenciaDto, @CurrentUser() user: JwtUser) {
    return this.sinReferencia.create(dto, user);
  }

  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Get('rebajas/sin-referencia')
  listSinReferencia(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.sinReferencia.list(sedeId, user);
  }

  /** Lo que ya se devolvió de esta venta (para no devolver dos veces). */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get(':id/returns')
  listReturns(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.returns.listForSale(id, user);
  }

  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Post(':id/void')
  void(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.sales.void(id, user);
  }
}
