/**
 * DIAGNÓSTICO TEMPORAL (ítem 2.13): en Vercel las peticiones reales no llegan a
 * Sentry como trazas (solo `/_vercel/ping`). Estas líneas `[diag-sentry]` dicen
 * por dónde se pierden. Se borra este archivo y sus llamadas al encontrar la
 * causa. Máximo 20 líneas por instancia y nunca datos de la petición más allá
 * del método y la plantilla de la ruta.
 */
const MAXIMO = 20;
let escritas = 0;

export function diagSentry(evento: string, datos: Record<string, unknown> = {}): void {
  try {
    if (escritas >= MAXIMO) return;
    escritas += 1;
    console.log(`[diag-sentry] ${JSON.stringify({ evento, pid: process.pid, n: escritas, ...datos })}`);
  } catch {
    // El diagnóstico jamás debe romper nada.
  }
}

/** Módulos de servidor ya cargados: si Express aparece antes de `Sentry.init`, no se instrumenta. */
export function modulosCargados(): Record<string, boolean> {
  try {
    const claves = Object.keys(require.cache);
    const hay = (trozo: string): boolean => claves.some((k) => k.replace(/\\/g, '/').includes(trozo));
    return {
      express: hay('/node_modules/express/'),
      nestCore: hay('/node_modules/@nestjs/core/'),
      appModule: hay('/app.module.'),
    };
  } catch {
    return {};
  }
}
