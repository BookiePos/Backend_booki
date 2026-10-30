import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { lastValueFrom, of, throwError } from 'rxjs';

const spanPropio = vi.hoisted(() => ({
  end: vi.fn(),
  spanContext: vi.fn(() => ({ traceFlags: 1 })),
}));
const raiz = vi.hoisted(() => ({ spanContext: vi.fn(() => ({ traceFlags: 1 })) }));
const sentry = vi.hoisted(() => ({
  getActiveSpan: vi.fn((): unknown => undefined),
  getRootSpan: vi.fn((..._a: unknown[]) => raiz),
  updateSpanName: vi.fn((..._a: unknown[]) => undefined),
  startInactiveSpan: vi.fn((..._a: unknown[]) => spanPropio),
  setHttpStatus: vi.fn((..._a: unknown[]) => undefined),
}));
vi.mock('@sentry/node', () => sentry);
const esperar = vi.hoisted(() => vi.fn((..._a: unknown[]) => undefined));
vi.mock('@vercel/functions', () => ({ waitUntil: esperar }));
const vaciar = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./sentry', () => ({ vaciarSentry: vaciar }));

import { SentryTransaccionInterceptor } from './sentry-transaccion.interceptor';

/** Respuesta mínima: `statusCode` y los eventos `finish`/`close` de Express. */
function respuesta(statusCode = 200): EventEmitter & { statusCode: number; writableFinished: boolean } {
  return Object.assign(new EventEmitter(), { statusCode, writableFinished: false });
}

function contexto(req: object, tipo = 'http', res: object = respuesta()): ExecutionContext {
  return {
    getType: () => tipo,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

const ok: CallHandler = { handle: () => of('ok') };
const venta = { method: 'POST', route: { path: '/sales/:id/void' }, url: '/sales/65f0c0ffee/void' };

describe('SentryTransaccionInterceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentry.getActiveSpan.mockReturnValue(undefined);
    spanPropio.spanContext.mockReturnValue({ traceFlags: 1 });
    raiz.spanContext.mockReturnValue({ traceFlags: 1 });
  });

  it('con transacción HTTP activa le pone método y plantilla y la envía al terminar la respuesta', async () => {
    sentry.getActiveSpan.mockReturnValue({ id: 'span' });
    const res = respuesta();
    await lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto(venta, 'http', res), ok));
    expect(sentry.updateSpanName).toHaveBeenCalledWith(raiz, 'POST /sales/:id/void');
    expect(sentry.startInactiveSpan).not.toHaveBeenCalled();
    expect(esperar).toHaveBeenCalledTimes(1);
    // No se vacía antes de responder: la transacción aún no se ha cerrado.
    await new Promise((r) => setImmediate(r));
    expect(vaciar).not.toHaveBeenCalled();
    res.emit('finish');
    await esperar.mock.calls[0]?.[0];
    expect(vaciar).toHaveBeenCalledTimes(1);
  });

  it('con transacción activa fuera del muestreo no programa envío', async () => {
    sentry.getActiveSpan.mockReturnValue({ id: 'span' });
    raiz.spanContext.mockReturnValue({ traceFlags: 0 });
    await lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto(venta), ok));
    expect(sentry.updateSpanName).toHaveBeenCalledTimes(1);
    expect(esperar).not.toHaveBeenCalled();
  });

  it('sin transacción activa (Vercel) abre una propia, la cierra con el estado y la envía', async () => {
    const valor = await lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto(venta, 'http', respuesta(201)), ok));
    expect(valor).toBe('ok');
    expect(sentry.startInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'POST /sales/:id/void', op: 'http.server', forceTransaction: true }),
    );
    expect(sentry.setHttpStatus).toHaveBeenCalledWith(spanPropio, 201);
    expect(spanPropio.end).toHaveBeenCalledTimes(1);
    expect(esperar).toHaveBeenCalledTimes(1);
  });

  it('registra el estado del error y lo deja pasar', async () => {
    const falla: CallHandler = { handle: () => throwError(() => new NotFoundException()) };
    await expect(lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto(venta), falla))).rejects.toThrow(
      NotFoundException,
    );
    expect(sentry.setHttpStatus).toHaveBeenCalledWith(spanPropio, 404);
    expect(spanPropio.end).toHaveBeenCalledTimes(1);
  });

  it('no envía nada si la traza no salió en el muestreo', async () => {
    spanPropio.spanContext.mockReturnValue({ traceFlags: 0 });
    await lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto(venta), ok));
    expect(spanPropio.end).toHaveBeenCalledTimes(1);
    expect(esperar).not.toHaveBeenCalled();
  });

  it('no mide nada fuera de HTTP ni sin plantilla de ruta', async () => {
    await lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto({}, 'rpc'), ok));
    await lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto({ method: 'GET' }), ok));
    expect(sentry.startInactiveSpan).not.toHaveBeenCalled();
    expect(sentry.updateSpanName).not.toHaveBeenCalled();
  });

  it('nunca rompe la petición si Sentry falla', async () => {
    sentry.getActiveSpan.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto(venta), ok))).toBe('ok');
  });
});
