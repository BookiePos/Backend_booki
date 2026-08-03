import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import { TenantContext, dbNameForBusiness } from './tenant-context';

interface AccessClaims {
  biz?: string;
}

/**
 * Abre el contexto de empresa a partir del claim `biz` del access token.
 *
 * Corre ANTES que los guards de Nest (es middleware de Express), y como
 * envuelve `next()` dentro de `TenantContext.run`, el contexto queda activo
 * para guards, el handler y los `tap`/`catchError` del interceptor de
 * auditoría. Las rutas públicas (login/registro/refresh/health) no traen
 * `Authorization`, así que siguen sin contexto y no tocan datos de tenant.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7);
      try {
        const claims = this.jwt.verify<AccessClaims>(token, {
          secret: this.config.get<string>('JWT_SECRET') ?? 'dev-secret',
        });
        if (claims?.biz) {
          const businessId = claims.biz;
          TenantContext.run(
            { businessId, dbName: dbNameForBusiness(businessId) },
            () => next(),
          );
          return;
        }
      } catch {
        // Token inválido/expirado: seguimos sin contexto; el JwtAuthGuard
        // responderá 401 en las rutas protegidas.
      }
    }
    next();
  }
}
