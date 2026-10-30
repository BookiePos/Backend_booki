import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';

const spanPropio = vi.hoisted(() => ({
  end: vi.fn(),
  isRecording: vi.fn(() => true),
  spanContext: vi.fn(() => ({ traceFlags: 1 })),
}));
const raiz = vi.hoisted(() => ({ isRecording: () => true, spanContext: () => ({ traceFlags: 1 }) }));
const sentry = vi.hoisted(() => ({
  getActiveSpan: vi.fn((): unknown => undefined),
  getRootSpan: vi.fn((..._a: unknown[]) => raiz),
  isInitialized: vi.fn(() => true),
  spanToJSON: vi.fn(() => ({ description: 'GET', op: 'http.server' })),
  flush: vi.fn(async () => true),
  updateSpanName: vi.fn((..._a: unknown[]) => undefined),
  startInactiveSpan: vi.fn((..._a: unknown[]) => spanPropio),
  setHttpStatus: vi.fn((..._a: unknown[]) => undefined),
}));
vi.mock('@sentry/node', () => sentry);
const esperar = vi.hoisted(() => vi.fn((..._a: unknown[]) => undefined));
vi.mock('@vercel/functions', () => ({ waitUntil: esperar }));
vi.mock('./diagnostico-sentry', () => ({ diagSentry: vi.fn() }));

import { SentryTransaccionInterceptor } from './sentry-transaccion.interceptor';

function contexto(req: object, tipo = 'http', statusCode = 200): ExecutionContext {
  return {
    getType: () => tipo,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ statusCode }) }),
  } as unknown as ExecutionContext;
}

const ok: CallHandler = { handle: () => of('ok') };
const venta = { method: 'POST', route: { path: '/sales/:id/void' }, url: '/sales/65f0c0ffee/void' };

describe('SentryTransaccionInterceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentry.getActiveSpan.mockReturnValue(undefined);
    spanPropio.spanContext.mockReturnValue({ traceFlags: 1 });
  });

  it('con transacción HTTP activa solo le pone método y plantilla de la ruta', async () => {
    sentry.getActiveSpan.mockReturnValue({ id: 'span' });
    await lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto(venta), ok));
    expect(sentry.updateSpanName).toHaveBeenCalledWith(raiz, 'POST /sales/:id/void');
    expect(sentry.startInactiveSpan).not.toHaveBeenCalled();
  });

  it('sin transacción activa (Vercel) abre una propia, la cierra con el estado y la envía', async () => {
    const valor = await lastValueFrom(new SentryTransaccionInterceptor().intercept(contexto(venta, 'http', 201), ok));
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
