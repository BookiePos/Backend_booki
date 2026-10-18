import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HttpException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';

const reportar = vi.hoisted(() => vi.fn((..._a: unknown[]) => undefined));
const vaciar = vi.hoisted(() => vi.fn(async () => undefined));
const esperar = vi.hoisted(() => vi.fn((..._a: unknown[]) => undefined));
vi.mock('./sentry', async (orig) => ({
  ...(await orig<typeof import('./sentry')>()),
  reportarError: reportar,
  vaciarSentry: vaciar,
}));
vi.mock('@vercel/functions', () => ({ waitUntil: esperar }));

import { SentryExceptionFilter } from './sentry-exception.filter';
import { iniciarSentry, limpiarEvento, rutaCritica, tasaDeMuestreo } from './sentry';

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

describe('tasaDeMuestreo', () => {
  const con = (v?: string) => tasaDeMuestreo({ SENTRY_TRACES_SAMPLE_RATE: v } as NodeJS.ProcessEnv);
  it('lee un valor entre 0 y 1', () => {
    expect(con('0.1')).toBe(0.1);
    expect(con('1')).toBe(1);
  });
  it('sin valor o inválido mide 0', () => {
    expect(con(undefined)).toBe(0);
    expect(con('')).toBe(0);
    expect(con('abc')).toBe(0);
    expect(con('2')).toBe(0);
    expect(con('-1')).toBe(0);
  });
});

describe('iniciarSentry', () => {
  it('sin SENTRY_DSN no se activa', () => {
    expect(iniciarSentry({} as NodeJS.ProcessEnv)).toBe(false);
    expect(iniciarSentry({ SENTRY_DSN: '  ' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('limpiarEvento', () => {
  type Ev = {
    user?: unknown;
    extra?: unknown;
    message?: string;
    request: {
      url?: string;
      data?: unknown;
      cookies?: unknown;
      query_string?: unknown;
      headers: Record<string, string>;
    };
    breadcrumbs?: Array<Record<string, unknown>>;
    exception?: { values: Array<{ value?: string }> };
  };
  const limpiar = (e: unknown) => limpiarEvento(e as never) as unknown as Ev;

  it('quita cuerpo, cookies, query y usuario', () => {
    const e = limpiar({
      user: { id: '1' },
      request: {
        data: { tarjeta: 'x' },
        cookies: { rt: 'y' },
        query_string: 'a=1',
        headers: {},
      },
    });
    expect(e.user).toBeUndefined();
    expect(e.request.data).toBeUndefined();
    expect(e.request.cookies).toBeUndefined();
    expect(e.request.query_string).toBeUndefined();
  });

  it('deja solo las cabeceras de la lista blanca', () => {
    const e = limpiar({
      request: {
        headers: {
          Authorization: 'Bearer z',
          'x-event-checksum': 'c',
          Referer: 'https://x/?token=1',
          'x-forwarded-for': '1.2.3.4',
          'User-Agent': 'ua',
          'content-type': 'application/json',
          accept: '*/*',
        },
      },
    });
    expect(Object.keys(e.request.headers).sort()).toEqual(['User-Agent', 'accept', 'content-type']);
  });

  it('recorta la URL a la ruta sin query', () => {
    const e = limpiar({
      request: {
        url: 'https://api.x.com/clientes?email=a@b.co#h',
        headers: {},
      },
    });
    expect(e.request.url).toBe('https://api.x.com/clientes');
  });

  it('reduce los breadcrumbs a categoría, mensaje recortado y nivel, y quita extra', () => {
    const e = limpiar({
      extra: { cedula: '123456789' },
      request: { headers: {} },
      breadcrumbs: [
        {
          category: 'http',
          message: 'x'.repeat(500),
          level: 'info',
          data: { url: '/a?b=1', body: 'secreto' },
          timestamp: 1,
        },
        {
          category: 'console',
          message: 'cliente ana@correo.com doc 1234567',
          level: 'log',
        },
      ],
    });
    expect(e.extra).toBeUndefined();
    expect(e.breadcrumbs?.[0]).toEqual({
      category: 'http',
      message: 'x'.repeat(200),
      level: 'info',
    });
    expect(e.breadcrumbs?.[1]?.message).toBe('cliente [email] doc [num]');
  });

  it('censura emails y documentos en el mensaje de la excepción', () => {
    const e = limpiar({
      request: { headers: {} },
      exception: {
        values: [
          {
            value: 'Cliente ana.p@correo.com con NIT 900123456-7 y tel 3001234567; id 12345',
          },
        ],
      },
    });
    expect(e.exception?.values[0]?.value).toBe(
      'Cliente [email] con NIT [num]-7 y tel [num]; id 12345',
    );
  });
});

describe('SentryExceptionFilter', () => {
  const host = (url: string) =>
    ({
      getType: () => 'http',
      getArgs: () => [],
      getArgByIndex: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          originalUrl: url,
          url,
          method: 'GET',
          route: { path: '/clientes/:id' },
        }),
        getResponse: () => ({}),
      }),
    }) as unknown as ArgumentsHost;
  const adaptador = {
    reply: vi.fn(),
    isHeadersSent: () => false,
    end: vi.fn(),
  };
  const filtro = () => new SentryExceptionFilter(adaptador as never);

  beforeEach(() => {
    reportar.mockClear();
    vaciar.mockClear();
    esperar.mockClear();
    adaptador.reply.mockClear();
  });

  it('reporta los 500 con la plantilla de ruta (no la URL real) y el método', () => {
    filtro().catch(new InternalServerErrorException(), host('/clientes/123?x=1'));
    expect(reportar).toHaveBeenCalledTimes(1);
    expect(reportar.mock.calls[0]?.[1]).toEqual({
      url: '/clientes/123?x=1',
      ruta: '/clientes/:id',
      metodo: 'GET',
    });
    expect(adaptador.reply).toHaveBeenCalled();
  });

  it('responde antes de reportar y manda el flush a waitUntil sin bloquear', () => {
    const orden: string[] = [];
    adaptador.reply.mockImplementationOnce(() => void orden.push('responde'));
    reportar.mockImplementationOnce(() => void orden.push('reporta'));
    esperar.mockImplementationOnce(() => void orden.push('waitUntil'));
    const r = filtro().catch(new InternalServerErrorException(), host('/cron/diario'));
    expect(r).toBeUndefined(); // síncrono: no devuelve promesa
    expect(orden).toEqual(['responde', 'reporta', 'waitUntil']);
    expect(vaciar).toHaveBeenCalledTimes(1);
    expect(esperar).toHaveBeenCalledTimes(1);
  });

  it('un fallo del monitoreo no rompe la respuesta', () => {
    reportar.mockImplementationOnce(() => {
      throw new Error('sentry caído');
    });
    expect(() => filtro().catch(new Error('boom'), host('/ventas'))).not.toThrow();
    expect(adaptador.reply).toHaveBeenCalled();
  });

  it('reporta errores no controlados', () => {
    filtro().catch(new Error('boom'), host('/ventas'));
    expect(reportar).toHaveBeenCalledTimes(1);
  });

  it('no reporta los 4xx', () => {
    filtro().catch(new NotFoundException(), host('/x'));
    filtro().catch(new HttpException('no', 401), host('/x'));
    expect(reportar).not.toHaveBeenCalled();
    expect(esperar).not.toHaveBeenCalled();
    expect(adaptador.reply).toHaveBeenCalledTimes(2);
  });
});
