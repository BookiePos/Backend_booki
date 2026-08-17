import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import {
  setRefreshCookie,
  clearRefreshCookie,
  REFRESH_COOKIE,
} from './auth-cookie';

/** ConfigService falso respaldado por un mapa. */
function fakeConfig(map: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

/** Response espía con cookie/clearCookie. */
function spyRes() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response & { cookie: ReturnType<typeof vi.fn>; clearCookie: ReturnType<typeof vi.fn> };
}

describe('setRefreshCookie', () => {
  it('usa httpOnly, path=/auth y sameSite=lax por defecto', () => {
    const res = spyRes();
    setRefreshCookie(res, 'tok', fakeConfig({}));
    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, token, opts] = res.cookie.mock.calls[0];
    expect(name).toBe(REFRESH_COOKIE);
    expect(token).toBe('tok');
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe('/auth');
    expect(opts.sameSite).toBe('lax');
  });

  it('respeta AUTH_COOKIE_SAMESITE=strict', () => {
    const res = spyRes();
    setRefreshCookie(res, 'tok', fakeConfig({ AUTH_COOKIE_SAMESITE: 'Strict' }));
    expect(res.cookie.mock.calls[0][2].sameSite).toBe('strict');
  });

  it('secure=false en dev', () => {
    const res = spyRes();
    setRefreshCookie(res, 'tok', fakeConfig({ NODE_ENV: 'development' }));
    expect(res.cookie.mock.calls[0][2].secure).toBe(false);
  });

  it('secure=true en producción', () => {
    const res = spyRes();
    setRefreshCookie(res, 'tok', fakeConfig({ NODE_ENV: 'production' }));
    expect(res.cookie.mock.calls[0][2].secure).toBe(true);
  });

  it('sameSite=none fuerza secure=true aun en dev', () => {
    const res = spyRes();
    setRefreshCookie(
      res,
      'tok',
      fakeConfig({ NODE_ENV: 'development', AUTH_COOKIE_SAMESITE: 'none' }),
    );
    const opts = res.cookie.mock.calls[0][2];
    expect(opts.sameSite).toBe('none');
    expect(opts.secure).toBe(true);
  });

  it('maxAge derivado de JWT_REFRESH_EXPIRES (7d -> 604800000)', () => {
    const res = spyRes();
    setRefreshCookie(res, 'tok', fakeConfig({ JWT_REFRESH_EXPIRES: '7d' }));
    expect(res.cookie.mock.calls[0][2].maxAge).toBe(604800000);
  });

  it('maxAge por defecto (sin var) = 7 días', () => {
    const res = spyRes();
    setRefreshCookie(res, 'tok', fakeConfig({}));
    expect(res.cookie.mock.calls[0][2].maxAge).toBe(7 * 24 * 3600 * 1000);
  });

  it('maxAge soporta minutos (15m -> 900000)', () => {
    const res = spyRes();
    setRefreshCookie(res, 'tok', fakeConfig({ JWT_REFRESH_EXPIRES: '15m' }));
    expect(res.cookie.mock.calls[0][2].maxAge).toBe(900000);
  });

  it('incluye domain solo si AUTH_COOKIE_DOMAIN está definido', () => {
    const sinDominio = spyRes();
    setRefreshCookie(sinDominio, 'tok', fakeConfig({}));
    expect(sinDominio.cookie.mock.calls[0][2].domain).toBeUndefined();

    const conDominio = spyRes();
    setRefreshCookie(
      conDominio,
      'tok',
      fakeConfig({ AUTH_COOKIE_DOMAIN: 'example.com' }),
    );
    expect(conDominio.cookie.mock.calls[0][2].domain).toBe('example.com');
  });
});

describe('clearRefreshCookie', () => {
  it('llama clearCookie con el mismo nombre y opciones base (sin maxAge)', () => {
    const res = spyRes();
    clearRefreshCookie(res, fakeConfig({ NODE_ENV: 'production' }));
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    const [name, opts] = res.clearCookie.mock.calls[0];
    expect(name).toBe(REFRESH_COOKIE);
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe('/auth');
    expect(opts.sameSite).toBe('lax');
    expect(opts.secure).toBe(true);
    expect(opts.maxAge).toBeUndefined();
  });
});
