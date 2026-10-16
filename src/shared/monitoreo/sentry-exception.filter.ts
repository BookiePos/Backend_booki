import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import { reportarError } from './sentry';

/**
 * Filtro global: responde igual que el de Nest por defecto y, además, reporta a
 * Sentry lo que es culpa del servidor (5xx y errores no controlados). Los 4xx
 * (validación, permisos, no encontrado) son del cliente y no se reportan.
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  override async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    if (host.getType() === 'http') {
      const status = exception instanceof HttpException ? exception.getStatus() : 500;
      if (status >= 500) {
        const req = host.switchToHttp().getRequest<Request>();
        await reportarError(exception, { url: req.originalUrl ?? req.url, metodo: req.method });
      }
    }
    super.catch(exception, host);
  }
}
