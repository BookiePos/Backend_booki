import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { AuditService } from '../application/audit.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** Verbos que se auditan (las lecturas GET no dejan rastro). */
const AUDITED_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Intercepta toda operación de escritura y la persiste en la auditoría
 * inmutable. Corre después de los guards, así que `req.user` ya está resuelto.
 * Errores de negocio también quedan registrados (success=false + mensaje).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: JwtUser }>();
    const method = req.method.toUpperCase();

    if (!AUDITED_METHODS.has(method)) return next.handle();

    const startedAt = Date.now();
    const base = {
      userId: req.user?.userId,
      userEmail: req.user?.email,
      userName: req.user?.name,
      role: req.user?.role,
      method,
      path: (req.originalUrl || req.url || '').split('?')[0] ?? '/',
      ip:
        (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0] ||
        req.ip,
    };

    return next.handle().pipe(
      tap(() => {
        const res = http.getResponse<Response>();
        void this.audit.record({
          ...base,
          statusCode: res.statusCode,
          success: true,
          durationMs: Date.now() - startedAt,
        });
      }),
      catchError((err: unknown) => {
        const status =
          typeof (err as { status?: number })?.status === 'number'
            ? (err as { status: number }).status
            : 500;
        void this.audit.record({
          ...base,
          statusCode: status,
          success: false,
          durationMs: Date.now() - startedAt,
          error: (err as Error)?.message,
        });
        return throwError(() => err);
      }),
    );
  }
}
