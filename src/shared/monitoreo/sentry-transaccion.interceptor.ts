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
 * Normalmente `@sentry/node` ya abrió la transacción HTTP: aquí se le pone el
 * nombre y, si salió en el muestreo, se programa el envío para cuando termine la
 * respuesta. En Vercel ese envío es obligatorio: la transacción se cierra al
 * responder y la función se congela antes de que Sentry vacíe su cola (lo
 * mostró el diagnóstico de #99: transacciones muestreadas que nunca llegaban).
 * Si no hay transacción activa, se abre una propia alrededor del handler.
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
        const raiz = Sentry.getRootSpan(activo);
        Sentry.updateSpanName(raiz, nombre);
        if (raiz.spanContext().traceFlags === MUESTREADA) enviarAlTerminar(res);
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

/**
 * Vacía Sentry cuando la respuesta ya salió (la transacción HTTP se cierra en
 * ese momento). `setImmediate` deja que Sentry encole la transacción antes de
 * vaciar; `close` cubre la conexión cortada, en la que `finish` no llega.
 */
function enviarAlTerminar(res: Response): void {
  const terminada = new Promise<void>((listo) => {
    if (res.writableFinished) return listo();
    res.once('finish', () => listo());
    res.once('close', () => listo());
  });
  waitUntil(
    terminada
      .then(() => new Promise<void>((listo) => setImmediate(listo)))
      .then(() => vaciarSentry()),
  );
}
