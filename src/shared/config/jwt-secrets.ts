import type { ConfigService } from '@nestjs/config';

/**
 * Lee un secreto obligatorio del entorno y **falla el arranque** si no está
 * definido. Evita fallbacks inseguros ('dev-secret') que dejarían la app con un
 * secreto conocido en producción.
 */
function requireSecret(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`${name} es obligatorio`);
  }
  return value;
}

/** Secreto de firma del access token. Obligatorio. */
export function jwtSecret(config: ConfigService): string {
  return requireSecret(config.get<string>('JWT_SECRET'), 'JWT_SECRET');
}

/**
 * Secreto de firma del refresh token. Si `JWT_REFRESH_SECRET` no está definido,
 * cae al `JWT_SECRET` (también obligatorio); nunca a un valor por defecto.
 */
export function jwtRefreshSecret(config: ConfigService): string {
  const refresh = config.get<string>('JWT_REFRESH_SECRET');
  if (refresh && refresh.trim() !== '') {
    return refresh;
  }
  return jwtSecret(config);
}
