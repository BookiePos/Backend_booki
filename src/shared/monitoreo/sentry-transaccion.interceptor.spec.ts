import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';

const sentry = vi.hoisted(() => ({
  getActiveSpan: vi.fn((): unknown => undefined),
  getRootSpan: vi.fn((s: unknown) => ({ raiz: s })),
  updateSpanName: vi.fn((..._a: unknown[]) => undefined),
}));
vi.mock('@sentry/node', () => sentry);

import { SentryTransaccionInterceptor } from './sentry-transaccion.interceptor';

function contexto(req: object, tipo = 'http'): ExecutionContext {
  return {
    getType: () => tipo,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const siguiente: CallHandler = { handle: () => of('ok') };

describe('SentryTransaccionInterceptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('nombra la transacción raíz con método y plantilla de la ruta', () => {
    sentry.getActiveSpan.mockReturnValue({ id: 'span' });
    new SentryTransaccionInterceptor().intercept(
      contexto({ method: 'POST', route: { path: '/sales/:id/void' }, url: '/sales/65f0c0ffee/void' }),
      siguiente,
    );
    expect(sentry.updateSpanName).toHaveBeenCalledWith({ raiz: { id: 'span' } }, 'POST /sales/:id/void');
  });

  it('no hace nada sin span activo (Sentry apagado) ni fuera de HTTP', () => {
    sentry.getActiveSpan.mockReturnValue(undefined);
    new SentryTransaccionInterceptor().intercept(contexto({ method: 'GET', route: { path: '/health' } }), siguiente);
    sentry.getActiveSpan.mockReturnValue({ id: 'span' });
    new SentryTransaccionInterceptor().intercept(contexto({}, 'rpc'), siguiente);
    expect(sentry.updateSpanName).not.toHaveBeenCalled();
  });

  it('nunca rompe la petición si Sentry falla', () => {
    sentry.getActiveSpan.mockImplementation(() => {
      throw new Error('boom');
    });
    let valor: unknown;
    new SentryTransaccionInterceptor()
      .intercept(contexto({ method: 'GET', route: { path: '/health' } }), siguiente)
      .subscribe((v) => (valor = v));
    expect(valor).toBe('ok');
  });
});
