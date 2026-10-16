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

/** Únicas cabeceras que viajan a Sentry; todo lo demás se descarta. */
const CABECERAS_PERMITIDAS = new Set(['user-agent', 'content-type', 'accept']);

const RE_EMAIL = /[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]+/g;
const RE_DOCUMENTO = /\d{6,}/g;
const MAX_MENSAJE = 200;

/** Censura emails y secuencias de 6 o más dígitos (cédulas, NIT, teléfonos). */
export function censurar(texto: string): string {
  return texto.replace(RE_EMAIL, '[email]').replace(RE_DOCUMENTO, '[num]');
}

function mensajeSeguro(texto: unknown): string | undefined {
  return typeof texto === 'string' ? censurar(texto.slice(0, MAX_MENSAJE)) : undefined;
}

/**
 * Quita del evento todo lo que pueda llevar datos personales o secretos: lista
 * blanca de cabeceras, URL sin query, sin cuerpo/cookies/usuario, breadcrumbs
 * reducidos a categoría + mensaje recortado + nivel, sin `extra`, y emails y
 * documentos censurados en los mensajes de excepción.
 */
export function limpiarEvento<T extends Sentry.ErrorEvent>(evento: T): T {
  const req = evento.request;
  if (req) {
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    if (typeof req.url === 'string') req.url = req.url.split(/[?#]/)[0];
    if (req.headers) {
      for (const h of Object.keys(req.headers)) {
        if (!CABECERAS_PERMITIDAS.has(h.toLowerCase())) delete req.headers[h];
      }
    }
  }
  delete evento.user;
  delete evento.extra;
  if (evento.breadcrumbs) {
    evento.breadcrumbs = evento.breadcrumbs.map((b) => {
      const limpio: Sentry.Breadcrumb = {};
      if (b.category) limpio.category = b.category;
      const m = mensajeSeguro(b.message);
      if (m !== undefined) limpio.message = m;
      if (b.level) limpio.level = b.level;
      return limpio;
    });
  }
  for (const v of evento.exception?.values ?? []) {
    if (typeof v.value === 'string') v.value = censurar(v.value);
  }
  if (typeof evento.message === 'string') evento.message = censurar(evento.message);
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
 * Registra el error en Sentry sin esperar al envío. Nunca lanza. `ruta` es la
 * plantilla de la ruta (`/clientes/:id`), no la URL real, para no multiplicar
 * las etiquetas; `url` solo sirve para reconocer las rutas críticas.
 */
export function reportarError(
  error: unknown,
  contexto: { url?: string; ruta?: string; metodo?: string } = {},
): void {
  if (!iniciado) return;
  try {
    const critica = rutaCritica(contexto.url);
    Sentry.withScope((scope) => {
      if (critica) {
        scope.setTag('ruta_critica', critica);
        scope.setLevel('fatal');
      }
      if (contexto.metodo) scope.setTag('metodo', contexto.metodo);
      scope.setTag('ruta', contexto.ruta ?? 'desconocida');
      Sentry.captureException(error);
    });
  } catch {
    // El monitoreo jamás debe romper la respuesta.
  }
}

/**
 * Espera a que los eventos pendientes salgan. En serverless la función se
 * congela al responder, así que se entrega a `waitUntil`. Nunca rechaza.
 */
export function vaciarSentry(): Promise<void> {
  if (!iniciado) return Promise.resolve();
  return Sentry.flush(2000).then(
    () => undefined,
    () => undefined,
  );
}
