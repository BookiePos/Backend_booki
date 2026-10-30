import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

/**
 * Nombra la transacción de Sentry con la plantilla de la ruta (`POST /sales/:id`)
 * (ítem 2.13). `@sentry/node` solo ve la petición HTTP y la deja como `GET`,
 * así que el tablero y el monitor de p95 de `/sales*` no tendrían con qué
 * filtrar. Se usa la plantilla y no la URL real para no multiplicar nombres
 * con los ids.
 */
@Injectable()
export class SentryTransaccionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    try {
      if (context.getType() === 'http') {
        const req = context.switchToHttp().getRequest<Request>();
        const ruta = (req.route as { path?: string } | undefined)?.path;
        const activo = Sentry.getActiveSpan();
        if (ruta && activo) Sentry.updateSpanName(Sentry.getRootSpan(activo), `${req.method} ${ruta}`);
      }
    } catch {
      // El monitoreo jamás debe romper la respuesta.
    }
    return next.handle();
  }
}
