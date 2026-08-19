import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FEATURE_KEY } from '../decorators/require-feature.decorator';
import { TenantContext } from '../../../../shared/tenancy/tenant-context';
import {
  effectiveEntitlements,
  planHasFeature,
  type PlanFeature,
} from '../../../control/domain/plans';
import { PlanUpgradeRequiredException } from '../../../control/domain/plan-upgrade.exception';

/**
 * Gating por PLAN (ortogonal a permisos). Si el handler declara
 * @RequireFeature() y el plan del tenant no la incluye, responde 402
 * PLAN_UPGRADE_REQUIRED. Los endpoints sin la anotación pasan (opt-in). Si no
 * hay plan en el contexto (flujos pre-auth o control-plane caído) se hace
 * fail-open, coherente con el TenantMiddleware.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const feature = this.reflector.getAllAndOverride<PlanFeature>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;

    const ctx = TenantContext.current();
    if (!ctx?.plan) return true;

    const entitlements = effectiveEntitlements(ctx.plan, ctx.addOns);
    if (planHasFeature(entitlements, feature)) return true;

    throw new PlanUpgradeRequiredException(
      'Tu plan actual no incluye esta función. Mejora tu plan para activarla.',
      { reason: 'feature', feature },
    );
  }
}
