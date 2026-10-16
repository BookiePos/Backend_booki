import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditController } from './audit.controller';
import { FeatureGuard } from '../../core-auth/infrastructure/guards/feature.guard';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { PlanUpgradeRequiredException } from '../../control/domain/plan-upgrade.exception';
import type { BusinessPlan } from '../../control/domain/plans';

/**
 * Ítem 3.10 (auditor de permisos UI): el menú escondía la Auditoría fuera del
 * plan Control, pero el API la servía a cualquier plan que la llamara directo.
 */
describe('AuditController · plan', () => {
  const guard = new FeatureGuard(new Reflector());
  const ctx = {
    getHandler: () => AuditController.prototype.list,
    getClass: () => AuditController,
  } as unknown as ExecutionContext;

  const con = (plan: BusinessPlan) =>
    TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', plan }, () => guard.canActivate(ctx));

  it('el plan Punto recibe 402', () => {
    expect(() => con('punto')).toThrow(PlanUpgradeRequiredException);
  });

  it('el plan Control entra', () => {
    expect(con('control')).toBe(true);
  });
});
