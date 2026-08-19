import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import { TenantContext, dbNameForBusiness } from './tenant-context';
import { jwtSecret } from '../config/jwt-secrets';
import type { BusinessType } from '../../modules/control/domain/control.constants';
import {
  normalizePlan,
  type BusinessPlan,
  type BusinessAddOns,
} from '../../modules/control/domain/plans';
import { BusinessService } from '../../modules/control/application/business.service';

interface AccessClaims {
  biz?: string;
  biztype?: BusinessType;
}

/** Motivo por el que una empresa no puede operar. */
type BlockReason = 'suspended' | 'trial_expired';

/** Estado + plan cacheados de una empresa (para no consultar por request). */
interface BusinessGate {
  /** `true` si la empresa puede operar; `false` si suspendida o trial vencido. */
  allowed: boolean;
  /** Por qué está bloqueada (solo cuando `allowed` es `false`). */
  reason?: BlockReason;
  /** Plan vigente (normalizado). Ausente si el control-plane no respondió. */
  plan?: BusinessPlan;
  /** Complementos contratados. */
  addOns?: BusinessAddOns;
  /** Momento (epoch ms) en que expira esta entrada de caché. */
  expiresAt: number;
}

/**
 * Abre el contexto de empresa desde el claim `biz` del access token, corta el
 * acceso de empresas SUSPENDIDAS o con trial vencido, y propaga el PLAN +
 * complementos del tenant al TenantContext para el gating por plan.
 *
 * Corre como middleware de Express (antes de los guards de Nest); envuelve
 * `next()` en `TenantContext.run`, así el plan queda disponible para guards,
 * handler e interceptores. Las rutas públicas (login/registro/refresh/health)
 * no traen Authorization y siguen sin contexto. El estado+plan se cachea por un
 * TTL corto; una suspensión o cambio de plan tarda hasta ese TTL en surtir
 * efecto. Fail-open si el control-plane no responde (no tumbamos tenants ni
 * bloqueamos features por su caída).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private static readonly STATUS_CACHE_TTL_MS = 60_000;
  private readonly gateCache = new Map<string, BusinessGate>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly businesses: BusinessService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7);
      try {
        const claims = this.jwt.verify<AccessClaims>(token, {
          secret: jwtSecret(this.config),
        });
        if (claims?.biz) {
          const businessId = claims.biz;
          void this.resolveGate(businessId)
            .then((gate) => {
              // Excepción: las rutas de facturación siguen abiertas aunque la
              // empresa esté suspendida o con el trial vencido — es justo donde
              // el dueño paga para reactivarse. El resto se bloquea.
              const billingBypass = (req.path ?? '').startsWith('/billing');
              if (!gate.allowed && !billingBypass) {
                const trialExpired = gate.reason === 'trial_expired';
                // Cuerpo con discriminador `code` para que el frontend distinga
                // esta suspensión de un 403 por permisos y muestre el aviso de
                // reactivación (no un "sin acceso" genérico).
                next(
                  new ForbiddenException({
                    statusCode: 403,
                    error: 'AccountSuspended',
                    code: 'ACCOUNT_SUSPENDED',
                    reason: gate.reason ?? 'suspended',
                    message: trialExpired
                      ? 'El periodo de prueba de tu empresa venció. Reactiva tu plan para volver a operar.'
                      : 'La cuenta de tu empresa está suspendida. Reactiva tu plan para volver a operar.',
                  }),
                );
                return;
              }
              TenantContext.run(
                {
                  businessId,
                  dbName: dbNameForBusiness(businessId),
                  tipoNegocio: claims.biztype,
                  plan: gate.plan,
                  addOns: gate.addOns,
                },
                () => next(),
              );
            })
            .catch((err) => next(err));
          return;
        }
      } catch {
        // Token inválido/expirado: seguimos sin contexto; el JwtAuthGuard 401.
      }
    }
    next();
  }

  /**
   * Estado + plan de la empresa, cacheado por un TTL corto. Fail-open si el
   * control-plane no responde: se deja pasar y sin plan (gating también abre).
   */
  private async resolveGate(businessId: string): Promise<BusinessGate> {
    const now = Date.now();
    const cached = this.gateCache.get(businessId);
    if (cached && cached.expiresAt > now) {
      return cached;
    }

    let gate: BusinessGate = {
      allowed: true,
      expiresAt: now + TenantMiddleware.STATUS_CACHE_TTL_MS,
    };
    try {
      const business = await this.businesses.findById(businessId);
      if (business) {
        const trialExpired =
          business.status === 'trial' &&
          business.trialEndsAt != null &&
          business.trialEndsAt.getTime() < now;
        const suspended = business.status === 'suspended';
        gate = {
          allowed: !suspended && !trialExpired,
          reason: suspended
            ? 'suspended'
            : trialExpired
              ? 'trial_expired'
              : undefined,
          plan: normalizePlan(business.plan),
          addOns: business.addOns,
          expiresAt: now + TenantMiddleware.STATUS_CACHE_TTL_MS,
        };
      }
      // Empresa inexistente: se deja pasar; los guards de auth resolverán.
    } catch {
      // Control-plane inaccesible: fail-open, sin plan.
    }

    this.gateCache.set(businessId, gate);
    return gate;
  }
}
