#!/usr/bin/env node
// sonda-prod.mjs — comprobación de SOLO LECTURA contra el API desplegado. Córrela tras cada despliegue.
//
// Variables (nunca se imprimen):
//   SONDA_API_URL    base del API, p. ej. https://api.ejemplo.com (sin barra final)
//   SONDA_EMAIL      usuario de una cuenta de prueba en producción
//   SONDA_PASSWORD   su contraseña
//
// Pasos: GET /health → POST /auth/login → GET /auth/me → GET /sedes.
// No crea, edita ni borra nada. El login emite un refresh token nuevo (queda una sesión
// abierta más para esa cuenta): por eso conviene una cuenta dedicada a la sonda.
//
// Salida: una línea por paso con su tiempo. Exit 0 = todo bien, 1 = algún paso falló,
// 2 = faltan variables.

const TIEMPO_MAX_MS = 15_000;

const { SONDA_API_URL, SONDA_EMAIL, SONDA_PASSWORD } = process.env;
const faltan = ['SONDA_API_URL', 'SONDA_EMAIL', 'SONDA_PASSWORD'].filter((v) => !process.env[v]);
if (faltan.length > 0) {
  console.error(`sonda: faltan variables de entorno: ${faltan.join(', ')}`);
  process.exit(2);
}

const base = SONDA_API_URL.replace(/\/+$/, '');
let fallos = 0;

/** Ejecuta un paso, mide el tiempo e imprime una línea. Devuelve el body o null si falló. */
async function paso(nombre, ruta, opciones, validar) {
  const inicio = performance.now();
  let estado = 'FALLA';
  let detalle = '';
  let body = null;
  try {
    const res = await fetch(`${base}${ruta}`, { ...opciones, signal: AbortSignal.timeout(TIEMPO_MAX_MS) });
    const texto = await res.text();
    try {
      body = texto ? JSON.parse(texto) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      detalle = `HTTP ${res.status}`;
    } else {
      const problema = validar(body);
      if (problema) detalle = `HTTP ${res.status}, ${problema}`;
      else {
        estado = 'OK';
        detalle = `HTTP ${res.status}`;
      }
    }
  } catch (err) {
    detalle = err?.name === 'TimeoutError' ? `sin respuesta en ${TIEMPO_MAX_MS} ms` : `error de red: ${err?.message}`;
  }
  const ms = Math.round(performance.now() - inicio);
  console.log(`${estado.padEnd(5)} ${nombre.padEnd(18)} ${String(ms).padStart(6)} ms  ${detalle}`);
  if (estado !== 'OK') {
    fallos++;
    return null;
  }
  return body;
}

const json = { 'Content-Type': 'application/json', Accept: 'application/json' };

await paso('GET /health', '/health', { headers: json }, (b) => {
  if (b?.status !== 'ok') return `status=${b?.status ?? 'ausente'}`;
  if (b?.db !== 'connected') return `db=${b?.db ?? 'ausente'}`;
  return null;
});

// El login responde { tokens: { accessToken }, user } (ver auth.controller.ts); el refresh
// token viaja solo en la cookie HttpOnly y esta sonda no lo necesita.
const login = await paso(
  'POST /auth/login',
  '/auth/login',
  { method: 'POST', headers: json, body: JSON.stringify({ email: SONDA_EMAIL, password: SONDA_PASSWORD }) },
  (b) => (typeof b?.tokens?.accessToken === 'string' ? null : 'no vino tokens.accessToken'),
);
const token = login?.tokens?.accessToken;

if (!token) {
  console.log('SALTA GET /auth/me         sin token');
  console.log('SALTA GET /sedes           sin token');
} else {
  const auth = { ...json, Authorization: `Bearer ${token}` };
  await paso('GET /auth/me', '/auth/me', { headers: auth }, (b) => (b && typeof b === 'object' ? null : 'body vacío'));
  await paso('GET /sedes', '/sedes', { headers: auth }, (b) => (Array.isArray(b) || Array.isArray(b?.items) ? null : 'no vino una lista'));
}

console.log(fallos === 0 ? 'sonda: OK' : `sonda: ${fallos} paso(s) fallaron`);
process.exit(fallos === 0 ? 0 : 1);
