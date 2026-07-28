import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from '../application/reports.service';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

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
