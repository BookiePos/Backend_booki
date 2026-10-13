/**
 * Lo que devuelve un barrido periódico al terminar.
 *
 * El temporizador lo ignora (solo le importa el log), pero `GET /cron/diario`
 * lo necesita: si un barrido falló, la respuesta tiene que ser un error para que
 * el panel de Vercel Cron lo marque en rojo. Un 200 que oculta un fallo es justo
 * lo que hacía que estos barridos pudieran no correr durante meses sin que nadie
 * se enterara.
 *
 * - `ok`: corrió entero.
 * - `omitido`: no corrió porque otro barrido de esta instancia ya estaba en marcha.
 * - `error`: no corrió, o corrió con fallos (ver `detalle`).
 */
export interface ResultadoBarrido {
  estado: 'ok' | 'omitido' | 'error';
  detalle?: string;
  cifras?: Record<string, number>;
}
