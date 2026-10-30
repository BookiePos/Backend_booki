/**
 * Arranque de Sentry antes que cualquier otro módulo (ítem 2.13). `@sentry/node`
 * instrumenta http y Express al cargarlos; si `Sentry.init` corre después de
 * importar `@nestjs/core` o el `AppModule`, las trazas salen como `GET` sin
 * ruta y sin medir la petición. Por eso `main.ts` importa este archivo primero.
 */
import * as Sentry from '@sentry/node';
import { iniciarSentry } from './shared/monitoreo/sentry';
import { diagSentry, modulosCargados } from './shared/monitoreo/diagnostico-sentry';

const antes = modulosCargados();
const activo = iniciarSentry();
diagSentry('arranque', {
  activo,
  inicializado: Sentry.isInitialized(),
  tasa: Sentry.getClient()?.getOptions().tracesSampleRate ?? null,
  entrada: require.main?.filename ?? null,
  argv1: process.argv[1] ?? null,
  cargadosAntesDeInit: antes,
});
