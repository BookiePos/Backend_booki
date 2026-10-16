import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { waitUntil } from '@vercel/functions';
import type { Request } from 'express';
import { reportarError, vaciarSentry } from './sentry';

/**
 * Filtro global: responde igual que el de Nest por defecto y, además, reporta a
 * Sentry lo que es culpa del servidor (5xx y errores no controlados). Los 4xx
 * (validación, permisos, no encontrado) son del cliente y no se reportan.
 *
 * La respuesta sale primero; el envío a Sentry corre detrás con `waitUntil`,
 * así que un Sentry lento no retrasa al cliente.
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    super.catch(exception, host);
    try {
      if (host.getType() !== 'http') return;
      const status = exception instanceof HttpException ? exception.getStatus() : 500;
      if (status < 500) return;
      const req = host.switchToHttp().getRequest<Request>();
      reportarError(exception, {
        url: req.originalUrl ?? req.url,
        // Plantilla de la ruta: evita alta cardinalidad (ids en la URL).
        ruta: (req.route as { path?: string } | undefined)?.path,
        metodo: req.method,
      });
      waitUntil(vaciarSentry());
    } catch {
      // El monitoreo jamás debe romper la respuesta.
    }
  }
}
