/**
 * `E2E_SIN_LIMITES=1` apaga el rate limiting y el bloqueo por cuenta para las
 * pruebas e2e, que inician sesión muchas veces seguidas desde la misma IP.
 * Nunca aplica en producción ni en Vercel, aunque alguien deje la variable.
 */
export function sinLimitesParaE2e(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.E2E_SIN_LIMITES === '1' && env.NODE_ENV !== 'production' && !env.VERCEL;
}
