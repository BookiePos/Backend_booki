/**
 * Duración máxima de la función en Vercel (`maxDuration`), en un solo sitio.
 *
 * El API se despliega con el preset NestJS: toda la aplicación es UNA función
 * (`src/main.ts`) y corre con Fluid compute, que es el modo por defecto. Con
 * Fluid, el plan Hobby da 300 s por defecto y 300 s de máximo; Pro da 300 s por
 * defecto y hasta 800 s. (Los 10 s / 60 s de Hobby son del modo sin Fluid.)
 * https://vercel.com/docs/functions/configuring-functions/duration
 *
 * Por qué NO está en `vercel.json`: `functions` empareja archivos de `api/` (o
 * rutas del framework); con el preset NestJS la clave `src/main.ts` no
 * empareja ninguna función y el build falla (commit 219feb0). Vercel solo
 * documenta la clave por entrypoint para los frameworks de Python. El valor se
 * fija en el panel: Settings → Functions → Advanced Settings → «Function Max
 * Duration». Se comprueba con `vercel inspect <url> --json` (campo `timeout`).
 *
 * Los presupuestos internos (cliente SOAP, emisión, reintentos, cron de
 * reconsulta) se miden contra esta cifra en `duracion-funcion.spec.ts`: si
 * alguien sube uno y deja de caber, el test falla. Si la cifra del panel
 * cambia, se cambia aquí en el mismo PR.
 */
export const DURACION_MAX_FUNCION_MS = 300_000;

/**
 * Tope del modo sin Fluid en Hobby. No es el modo de este proyecto; está para
 * que el test diga qué caminos de usuario seguirían cabiendo si se apagara.
 */
export const DURACION_MAX_HOBBY_SIN_FLUID_MS = 60_000;
