import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from '../application/audit.service';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { RequireFeature } from '../../core-auth/infrastructure/decorators/require-feature.decorator';
import { PLAN_FEATURES } from '../../control/domain/plans';

/**
 * La auditoría es del plan Control en adelante. El menú ya la escondía en los
 * planes menores, pero el API la servía igual a quien la llamara directo: el
 * plan lo cobra el servidor, no la pantalla (ítem 3.10).
 */
@RequireFeature(PLAN_FEATURES.AUDIT)
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
