import { Controller, Get, Param, Query } from '@nestjs/common';
import { ReportsService } from '../application/reports.service';
import { TraceabilityService } from '../application/traceability.service';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly traceability: TraceabilityService,
  ) {}

  // ─── Trazabilidad hacia adelante ───────────────────────────────────────────
  // "El lote L-2409 salió malo, ¿a dónde se fue?". Va con `inventory.view` y no
  // con `reports.view`: quien maneja los lotes es quien tiene que responder
  // esto, y normalmente no es quien mira los estados financieros.

  /** Busca lotes por código, para poder escribir "L-2409" y encontrarlo. */
  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('trazabilidad/lotes')
  findLots(@Query('code') code: string, @CurrentUser() user: JwtUser) {
    return this.traceability.findLots(code ?? '', user);
  }

  /** A qué ventas y a qué clientes se fue este lote, pasando por producción. */
  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW)
  @Get('trazabilidad/lotes/:id')
  traceLot(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.traceability.traceLot(id, user);
  }

  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @Get()
  catalog() {
    return this.reports.catalog();
  }

  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @Get('income-statement')
  incomeStatement(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sedeId') sedeId?: string,
  ) {
    return this.reports.incomeStatement({ from, to, sedeId });
  }

  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @Get('balance-sheet')
  balanceSheet(@Query('to') to?: string, @Query('sedeId') sedeId?: string) {
    return this.reports.balanceSheet({ to, sedeId });
  }

  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @Get('trial-balance')
  trialBalance(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sedeId') sedeId?: string,
  ) {
    return this.reports.trialBalance({ from, to, sedeId });
  }

  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @Get('sales')
  salesReport(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sedeId') sedeId?: string,
  ) {
    return this.reports.salesReport({ from, to, sedeId });
  }
}
