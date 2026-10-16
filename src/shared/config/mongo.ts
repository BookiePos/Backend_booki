/**
 * Pool de conexiones a Mongo para funciones serverless (ítem 2.11). Cada
 * instancia de la función abre su propio pool; con el valor por defecto del
 * driver (100) unas pocas instancias en paralelo agotaban las conexiones del
 * cluster. Las ociosas se cierran porque la función se congela entre requests.
 */
export const POOL_MONGO = {
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,
} as const;

/**
 * La URI para los logs: sin usuario, contraseña ni parámetros. La URI completa
 * de Atlas trae la contraseña y no puede quedar en los logs de Vercel.
 */
export function uriSinCredenciales(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//***@').replace(/\?.*$/, '');
}
