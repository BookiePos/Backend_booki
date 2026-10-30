// Crea el tablero «Salud de Booki» (ítem 2.13, Backend/docs/TABLERO-SALUD.md) en Sentry.
// Lee SENTRY_AUTH_TOKEN de Backend/.env.sentry.local (ignorado por git). Uso:
//   node scripts/sentry-tablero-salud.mjs .env.sentry.local
import { readFileSync } from 'node:fs';

const archivo = process.argv[2];
const token = readFileSync(archivo, 'utf8').match(/^SENTRY_AUTH_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error(`Falta SENTRY_AUTH_TOKEN en ${archivo}`);

const API = 'https://us.sentry.io/api/0/organizations/bookipos';
const BACKEND = 4512346929823744;
const TITULO = 'Salud de Booki';

const errores = (titulo, condiciones, x, y, w = 3, display = 'table') => ({
  title: titulo,
  displayType: display,
  widgetType: 'error-events',
  interval: '1h',
  layout: { x, y, w, h: 2, minH: 2 },
  queries: [{
    name: '',
    conditions: condiciones,
    fields: ['title', 'count()', 'last_seen()'],
    aggregates: ['count()', 'last_seen()'],
    columns: ['title'],
    orderby: '-count()',
  }],
});

const p95 = (titulo, transaccion, x, y) => ({
  title: titulo,
  displayType: 'line',
  widgetType: 'spans',
  interval: '1h',
  layout: { x, y, w: 3, h: 2, minH: 2 },
  queries: [{
    name: 'p95',
    conditions: `is_transaction:true transaction:${transaccion}`,
    fields: ['p95(span.duration)'],
    aggregates: ['p95(span.duration)'],
    columns: [],
    orderby: '',
  }],
});

const tablero = {
  title: TITULO,
  projects: [BACKEND],
  environment: ['production'],
  period: '7d',
  widgets: [
    {
      title: 'Errores por hora (por ruta)',
      displayType: 'line',
      widgetType: 'error-events',
      interval: '1h',
      layout: { x: 0, y: 0, w: 6, h: 2, minH: 2 },
      // Una serie por ruta: Sentry exige `limit` (máximo 10) al agrupar.
      limit: 5,
      queries: [{
        name: '',
        conditions: '',
        fields: ['ruta', 'count()'],
        aggregates: ['count()'],
        columns: ['ruta'],
        orderby: '-count()',
      }],
    },
    p95('Latencia del POS (p95, /sales*)', '*/sales*', 0, 2),
    p95('Latencia de login (p95)', '*/auth/login', 3, 2),
    errores('Cron diario (si hay algo, el barrido falló)', 'ruta_critica:cron-diario', 0, 4),
    errores('Cobros: webhook de Wompi', 'ruta_critica:billing-webhook', 3, 4),
  ],
};

const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const lista = await fetch(`${API}/dashboards/?query=${encodeURIComponent(TITULO)}`, { headers: h });
if (!lista.ok) throw new Error(`Listar: HTTP ${lista.status} ${await lista.text()}`);
const previo = (await lista.json()).find((d) => d.title === TITULO);

const r = previo
  ? await fetch(`${API}/dashboards/${previo.id}/`, { method: 'PUT', headers: h, body: JSON.stringify(tablero) })
  : await fetch(`${API}/dashboards/`, { method: 'POST', headers: h, body: JSON.stringify(tablero) });
const cuerpo = await r.text();
if (!r.ok) throw new Error(`${previo ? 'Actualizar' : 'Crear'}: HTTP ${r.status} ${cuerpo}`);
const d = JSON.parse(cuerpo);
console.log(`${previo ? 'Actualizado' : 'Creado'}: https://bookipos.sentry.io/dashboard/${d.id}/ (${d.widgets.length} widgets)`);
