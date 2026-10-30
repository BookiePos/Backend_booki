import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { waitUntil } from '@vercel/functions';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { vaciarSentry } from './sentry';

/** Bandera W3C de traza muestreada: solo esas se envían a Sentry. */
const MUESTREADA = 1;

/**
 * Mide cada petición en Sentry con el nombre de su ruta (`POST /sales/:id`) para
 * el tablero de salud (ítem 2.13). Se usa la plantilla y no la URL real para no
 * multiplicar nombres con los ids.
 *
 * En local, `@sentry/node` abre la transacción HTTP y aquí solo se le pone el
 * nombre (él la deja como `GET`). En Vercel las peticiones no pasan por el
 * servidor http que instrumenta Sentry (solo `/_vercel/ping` lo hace), así que no
 * hay transacción activa: se abre una propia alrededor del handler y se envía
 * con `waitUntil`, porque la función se congela al responder.
 */
@Injectable()
export class SentryTransaccionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    let span: Sentry.Span | undefined;
    let res: Response | undefined;
    try {
      if (context.getType() !== 'http') return next.handle();
      const req = context.switchToHttp().getRequest<Request>();
      res = context.switchToHttp().getResponse<Response>();
      const ruta = (req.route as { path?: string } | undefined)?.path;
      if (!ruta) return next.handle();
      const nombre = `${req.method} ${ruta}`;
      const activo = Sentry.getActiveSpan();
      if (activo) {
        Sentry.updateSpanName(Sentry.getRootSpan(activo), nombre);
        return next.handle();
      }
      span = Sentry.startInactiveSpan({
        name: nombre,
        op: 'http.server',
        forceTransaction: true,
        attributes: { 'http.request.method': req.method, 'http.route': ruta },
      });
    } catch {
      // El monitoreo jamás debe romper la respuesta.
      return next.handle();
    }
    const cerrar = (status: number): void => {
      try {
        if (!span) return;
        Sentry.setHttpStatus(span, status);
        const enviar = span.spanContext().traceFlags === MUESTREADA;
        span.end();
        span = undefined;
        if (enviar) waitUntil(vaciarSentry());
      } catch {
        // Ídem.
      }
    };
    return next.handle().pipe(
      tap({
        next: () => cerrar(res?.statusCode ?? 200),
        error: (e: unknown) => cerrar(e instanceof HttpException ? e.getStatus() : 500),
        complete: () => cerrar(res?.statusCode ?? 200),
      }),
    );
  }
}
