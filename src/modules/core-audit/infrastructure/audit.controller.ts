import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from '../application/audit.service';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermissions(PERMISSIONS.AUDIT_VIEW)
  @Get()
  list(
    @Query('userEmail') userEmail?: string,
    @Query('module') module?: string,
    @Query('method') method?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.audit.list({
      userEmail,
      module,
      method,
      from,
      to,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @RequirePermissions(PERMISSIONS.AUDIT_VIEW)
  @Get('modules')
  modules() {
    return this.audit.modules();
  }
}
