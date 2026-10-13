import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * ¿La cabecera `Authorization` trae el secreto del cron?
 *
 * Vercel Cron llama al endpoint con `Authorization: Bearer <CRON_SECRET>` cuando
 * la variable existe en el proyecto. Se compara en tiempo constante (sobre los
 * hash, para que la longitud tampoco se filtre). Sin secreto configurado nunca
 * es válido: el endpoint queda cerrado, no abierto.
 */
export function secretoDeCronValido(
  authorization: string | undefined,
  secreto: string | undefined,
): boolean {
  if (!secreto || !authorization) return false;
  const esperado = createHash('sha256').update(`Bearer ${secreto}`).digest();
  const recibido = createHash('sha256').update(authorization).digest();
  return timingSafeEqual(esperado, recibido);
}
