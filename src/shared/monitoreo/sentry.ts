import * as Sentry from '@sentry/node';

/**
 * Monitoreo de errores (ítem 2.4). Sentry solo se activa si existe `SENTRY_DSN`;
 * sin él todo esto es un no-op, así que desarrollo, pruebas y despliegues sin
 * cuenta de Sentry siguen igual.
 */

/** Rutas cuyo fallo debe disparar alerta propia en Sentry (regla por la etiqueta `ruta_critica`). */
const RUTAS_CRITICAS: ReadonlyArray<{ patron: RegExp; nombre: string }> = [
  { patron: /^\/cron\/diario(\/|\?|$)/, nombre: 'cron-diario' },
  { patron: /^\/billing\/webhook(\/|\?|$)/, nombre: 'billing-webhook' },
];

/** Nombre de la ruta crítica a la que pertenece la URL, o `undefined`. */
export function rutaCritica(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return RUTAS_CRITICAS.find((r) => r.patron.test(url))?.nombre;
}

/** Quita del evento todo lo que pueda llevar datos personales o secretos. */
export function limpiarEvento<T extends Sentry.ErrorEvent>(evento: T): T {
  const req = evento.request;
  if (req) {
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    if (req.headers) {
      for (const h of Object.keys(req.headers)) {
        if (/^(authorization|cookie|x-.*(secret|signature|checksum).*)$/i.test(h)) {
          delete req.headers[h];
        }
      }
    }
  }
  delete evento.user;
  return evento;
}

let iniciado = false;

/** Inicia Sentry una sola vez. Devuelve `true` si quedó activo. */
export function iniciarSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  if (iniciado) return true;
  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT ?? env.VERCEL_ENV ?? env.NODE_ENV ?? 'development',
    release: env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    beforeSend: limpiarEvento,
  });
  iniciado = true;
  return true;
}

/**
 * Reporta un error. En serverless la función se congela al responder: se espera
 * al envío (`flush`) para que el evento no se pierda. Nunca lanza.
 */
export async function reportarError(
  error: unknown,
  contexto: { url?: string; metodo?: string } = {},
): Promise<void> {
  if (!iniciado) return;
  try {
    const critica = rutaCritica(contexto.url);
    Sentry.withScope((scope) => {
      if (critica) {
        scope.setTag('ruta_critica', critica);
        scope.setLevel('fatal');
      }
      if (contexto.metodo) scope.setTag('metodo', contexto.metodo);
      if (contexto.url) scope.setTag('ruta', contexto.url.split('?')[0]);
      Sentry.captureException(error);
    });
    await Sentry.flush(2000);
  } catch {
    // El monitoreo jamás debe romper la respuesta.
  }
}
