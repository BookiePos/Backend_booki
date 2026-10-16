import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HttpException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';

const reportar = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('./sentry', async (orig) => ({
  ...(await orig<typeof import('./sentry')>()),
  reportarError: reportar,
}));

import { SentryExceptionFilter } from './sentry-exception.filter';
import { iniciarSentry, limpiarEvento, rutaCritica } from './sentry';

describe('rutaCritica', () => {
  it('reconoce el cron diario y el webhook de facturación', () => {
    expect(rutaCritica('/cron/diario')).toBe('cron-diario');
    expect(rutaCritica('/billing/webhook')).toBe('billing-webhook');
    expect(rutaCritica('/billing/webhook?x=1')).toBe('billing-webhook');
  });
  it('ignora el resto', () => {
    expect(rutaCritica('/billing/plan')).toBeUndefined();
    expect(rutaCritica('/cron/diarioX')).toBeUndefined();
    expect(rutaCritica(undefined)).toBeUndefined();
  });
});

describe('iniciarSentry', () => {
  it('sin SENTRY_DSN no se activa', () => {
    expect(iniciarSentry({} as NodeJS.ProcessEnv)).toBe(false);
    expect(iniciarSentry({ SENTRY_DSN: '  ' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('limpiarEvento', () => {
  it('quita cuerpo, cookies, usuario y cabeceras secretas', () => {
    const e = limpiarEvento({
      user: { id: '1' },
      request: {
        data: { tarjeta: 'x' },
        cookies: { rt: 'y' },
        query_string: 'a=1',
        headers: { authorization: 'Bearer z', 'x-event-checksum': 'c', 'user-agent': 'ua' },
      },
    } as never) as { user?: unknown; request: { data?: unknown; headers: Record<string, string> } };
    expect(e.user).toBeUndefined();
    expect(e.request.data).toBeUndefined();
    expect(e.request.headers).toEqual({ 'user-agent': 'ua' });
  });
});

describe('SentryExceptionFilter', () => {
  const host = (url: string) =>
    ({
      getType: () => 'http',
      getArgs: () => [],
      getArgByIndex: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ originalUrl: url, url, method: 'GET' }),
        getResponse: () => ({}),
      }),
    }) as unknown as ArgumentsHost;
  const adaptador = { reply: vi.fn(), isHeadersSent: () => false, end: vi.fn() };
  const filtro = () => new SentryExceptionFilter(adaptador as never);

  beforeEach(() => {
    reportar.mockClear();
    adaptador.reply.mockClear();
  });

  it('reporta los 500 con la URL y el método', async () => {
    await filtro().catch(new InternalServerErrorException(), host('/cron/diario'));
    expect(reportar).toHaveBeenCalledTimes(1);
    expect(reportar.mock.calls[0]?.[1]).toEqual({ url: '/cron/diario', metodo: 'GET' });
    expect(adaptador.reply).toHaveBeenCalled();
  });

  it('reporta errores no controlados', async () => {
    await filtro().catch(new Error('boom'), host('/ventas'));
    expect(reportar).toHaveBeenCalledTimes(1);
  });

  it('no reporta los 4xx', async () => {
    await filtro().catch(new NotFoundException(), host('/x'));
    await filtro().catch(new HttpException('no', 401), host('/x'));
    expect(reportar).not.toHaveBeenCalled();
    expect(adaptador.reply).toHaveBeenCalledTimes(2);
  });
});
