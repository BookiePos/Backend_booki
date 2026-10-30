/**
 * Arranque de Sentry antes que cualquier otro módulo (ítem 2.13). `@sentry/node`
 * instrumenta http y Express al cargarlos; si `Sentry.init` corre después de
 * importar `@nestjs/core` o el `AppModule`, las trazas salen como `GET` sin
 * ruta y sin medir la petición. Por eso `main.ts` importa este archivo primero.
 */
import { iniciarSentry } from './shared/monitoreo/sentry';

iniciarSentry();
