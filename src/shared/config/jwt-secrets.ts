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
 * Secreto de firma del refresh token. Obligatorio y DISTINTO del de acceso
 * (ítem 3.7).
 *
 * Antes caía a `JWT_SECRET` si faltaba. Con un único secreto, un access token
 * pasaba la verificación del refresh y viceversa: `refresh` leía un `jti`
 * inexistente (`findOne({jti: undefined})` devuelve cualquier fila) y podía
 * rotar la sesión de otra persona. El claim `typ` cierra el mismo hueco por
 * otra vía; los dos juntos no dependen el uno del otro.
 */
export function jwtRefreshSecret(config: ConfigService): string {
  const refresh = requireSecret(
    config.get<string>('JWT_REFRESH_SECRET'),
    'JWT_REFRESH_SECRET',
  );
  if (refresh === jwtSecret(config)) {
    throw new Error('JWT_REFRESH_SECRET debe ser distinto de JWT_SECRET');
  }
  return refresh;
}
