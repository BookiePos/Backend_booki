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
import { BusinessService } from '../../modules/control/application/business.service';

interface AccessClaims {
  biz?: string;
  biztype?: BusinessType;
}

/** Resultado cacheado del estado de una empresa (para no consultar por request). */
interface BusinessGate {
  /** `true` si la empresa puede operar; `false` si está suspendida o el trial venció. */
  allowed: boolean;
  /** Momento (epoch ms) en que expira esta entrada de caché. */
  expiresAt: number;
}

/**
 * Abre el contexto de empresa a partir del claim `biz` del access token y, de
 * paso, corta el acceso de las empresas SUSPENDIDAS o con el trial vencido.
 *
 * Corre ANTES que los guards de Nest (es middleware de Express), y como
 * envuelve `next()` dentro de `TenantContext.run`, el contexto queda activo
 * para guards, el handler y los `tap`/`catchError` del interceptor de
 * auditoría. Las rutas públicas (login/registro/refresh/health) no traen
 * `Authorization`, así que siguen sin contexto y no tocan datos de tenant —
 * por lo mismo, el bloqueo por estado NO aplica a esos flujos: una empresa
 * suspendida puede seguir autenticándose y (a futuro) pagar/reactivarse.
 *
 * Garantía y límites del bloqueo:
 *  - Solo aplica a requests con `Authorization: Bearer` válido (tenant known).
 *  - El estado se consulta al control-plane y se CACHEA en memoria por
 *    `STATUS_CACHE_TTL_MS`; una suspensión puede tardar hasta ese TTL en surtir
 *    efecto (compromiso pragmático para no pegarle a la BD en cada request).
 *  - Si el control-plane no responde, se hace *fail-open* (se deja pasar) para
 *    no tumbar a todos los tenants por una caída del control-plane; el resto de
 *    guards de auth siguen aplicando.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  /** Cuánto se confía en el estado cacheado de una empresa (ms). */
  private static readonly STATUS_CACHE_TTL_MS = 60_000;

  /** Caché en memoria: businessId → estado de acceso vigente. */
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
          void this.assertBusinessAllowed(businessId)
            .then(() => {
              TenantContext.run(
                {
                  businessId,
                  dbName: dbNameForBusiness(businessId),
                  tipoNegocio: claims.biztype,
                },
                () => next(),
              );
            })
            .catch((err) => next(err));
          return;
        }
      } catch {
        // Token inválido/expirado: seguimos sin contexto; el JwtAuthGuard
        // responderá 401 en las rutas protegidas.
      }
    }
    next();
  }

  /**
   * Lanza 403 si la empresa está suspendida o su trial venció. Cachea el
   * resultado por un TTL corto y hace fail-open si el control-plane no responde.
   */
  private async assertBusinessAllowed(businessId: string): Promise<void> {
    const now = Date.now();
    const cached = this.gateCache.get(businessId);
    if (cached && cached.expiresAt > now) {
      if (!cached.allowed) {
        throw new ForbiddenException(
          'La cuenta de tu empresa está suspendida o el periodo de prueba venció. Contacta a soporte para reactivarla.',
        );
      }
      return;
    }

    let allowed = true;
    try {
      const business = await this.businesses.findById(businessId);
      if (business) {
        const trialExpired =
          business.status === 'trial' &&
          business.trialEndsAt != null &&
          business.trialEndsAt.getTime() < now;
        allowed = business.status !== 'suspended' && !trialExpired;
      }
      // Empresa inexistente: se deja pasar; los guards de auth resolverán el
      // caso (no es un estado de suspensión que debamos convertir en 403 aquí).
    } catch {
      // Control-plane inaccesible: fail-open para no tumbar a todos los tenants.
      allowed = true;
    }

    this.gateCache.set(businessId, {
      allowed,
      expiresAt: now + TenantMiddleware.STATUS_CACHE_TTL_MS,
    });

    if (!allowed) {
      throw new ForbiddenException(
        'La cuenta de tu empresa está suspendida o el periodo de prueba venció. Contacta a soporte para reactivarla.',
      );
    }
  }
}
