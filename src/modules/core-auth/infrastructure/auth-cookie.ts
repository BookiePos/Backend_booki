import type { Response } from 'express';
import type { ConfigService } from '@nestjs/config';

/**
 * Cookie HttpOnly que transporta el refresh token. Al vivir fuera del alcance de
 * JavaScript, un XSS ya no puede robar la credencial durable (7 días); el access
 * token de vida corta viaja aparte. La cookie se acota a `/auth`, así que solo se
 * envía a los endpoints que la necesitan (refresh/logout).
 */
export const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/auth';

type SameSite = 'lax' | 'strict' | 'none';

function sameSite(config: ConfigService): SameSite {
  const raw = (config.get<string>('AUTH_COOKIE_SAMESITE') ?? 'lax')
    .trim()
    .toLowerCase();
  return raw === 'strict' || raw === 'none' ? raw : 'lax';
}

function isSecure(config: ConfigService): boolean {
  // SameSite=None exige Secure. En producción siempre Secure; en dev sobre
  // http://localhost debe ir sin Secure o el navegador descarta la cookie.
  if (sameSite(config) === 'none') return true;
  return (config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) === 'production';
}

/** Convierte "7d" / "15m" / "24h" / "3600" a milisegundos. */
function maxAgeMs(config: ConfigService): number {
  const expires = (config.get<string>('JWT_REFRESH_EXPIRES') ?? '7d').trim();
  const match = /^(\d+)([smhd])?$/.exec(expires);
  const fallback = 7 * 24 * 3600 * 1000;
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const seconds =
    unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return amount * seconds * 1000;
}

function baseOptions(config: ConfigService) {
  const domain = config.get<string>('AUTH_COOKIE_DOMAIN')?.trim();
  return {
    httpOnly: true,
    secure: isSecure(config),
    sameSite: sameSite(config),
    path: COOKIE_PATH,
    ...(domain ? { domain } : {}),
  } as const;
}

export function setRefreshCookie(
  res: Response,
  token: string,
  config: ConfigService,
): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...baseOptions(config),
    maxAge: maxAgeMs(config),
  });
}

export function clearRefreshCookie(res: Response, config: ConfigService): void {
  // clearCookie debe usar las mismas opciones (path/domain/sameSite) que set.
  res.clearCookie(REFRESH_COOKIE, baseOptions(config));
}
