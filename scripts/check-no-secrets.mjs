#!/usr/bin/env node
// check-no-secrets.mjs — impide que un secreto entre al repositorio.
//
// Modos:
//   (sin argumentos)    revisa el diff STAGED. Es lo que corre el hook pre-commit.
//   --desde <ref>       revisa las líneas añadidas en <ref>...HEAD. Es lo que corre el CI en un PR.
//   --arbol             revisa todos los archivos versionados (git ls-files). Lo usa scripts/gates.mjs.
//
// Reglas:
//   - Nombres que nunca se versionan: .env*, *.key, *.pem, *.p12, *.pfx, id_rsa, id_ed25519
//     (salvo plantillas *.example / *.sample / *.template).
//   - Patrones de contenido con longitud de secreto real, para no disparar con menciones en docs.
//   - Falso positivo: pon `secretos-ok` en la MISMA línea y explica por qué en el PR.
//
// Diseño:
//   - Falla CERRADO: si git no responde, sale con 1 y no imprime la cifra (el gate queda SIN MEDIR).
//   - Imprime SIEMPRE la línea `secretos (<modo>): N archivos, M líneas revisadas, K hallazgos`.
//   - Nunca imprime el valor encontrado: solo archivo, línea y tipo.
//   - Es Node puro (sin bash) para que corra igual en Windows y en Linux/CI.
//
// Este archivo es IDÉNTICO en Backend y Frontend: si lo cambias en uno, cópialo al otro.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

const MARCADOR = 'secretos-ok';

const PATRONES = [
  { tipo: 'Wompi llave privada', re: /prv_(test|prod)_[A-Za-z0-9]{16,}/ },
  { tipo: 'Wompi secreto de integridad/eventos', re: /\b(test|prod)_(integrity|events)_[A-Za-z0-9]{16,}/ },
  { tipo: 'Resend API key', re: /\bre_[A-Za-z0-9]{6,}_?[A-Za-z0-9]{16,}/ },
  { tipo: 'Supabase token personal', re: /\bsbp_[A-Za-z0-9]{20,}/ },
  { tipo: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
  { tipo: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { tipo: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { tipo: 'API key sk- (OpenAI u otra)', re: /\bsk-(proj-)?[A-Za-z0-9]{20,}/ },
  { tipo: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { tipo: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { tipo: 'Clave privada PEM', re: /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----/ },
];

// mongodb://usuario:contraseña@host — solo es hallazgo si la contraseña no es un marcador.
const MONGO_URI = /mongodb(\+srv)?:\/\/([^:/\s@'"`]+):([^@\s/'"`]+)@/g;

function esMarcador(pass) {
  if (pass.length < 4) return true;
  if (/[<>{}*$]/.test(pass)) return true; // <pass>, ${MONGO_PASS}, ****
  if (/^(x+|\.+|_+|-+)$/i.test(pass)) return true;
  return /^(pass(word)?|contrase(n|ñ)a|clave|secret[oa]?|changeme|cambiame|example|ejemplo|usuario|user|test|demo|admin|root|tu[_-]?\w*|your[_-]?\w*|mi[_-]?\w*)$/i.test(
    pass,
  );
}

// `re_xxxxxxxxxxxxxxxxxxxx` en un .env.example es un ejemplo, no una llave: los últimos 16
// caracteres de un valor real son aleatorios y casi no se repiten. Se mira solo la cola para
// que el prefijo (`test_integrity_`, `sk-ant-`) no cuente como variedad.
function esRelleno(valor) {
  return new Set(valor.slice(-16)).size < 6;
}

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json', 'bun.lockb']);
const BINARIOS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff', '.avif', '.heic',
  '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt',
  '.zip', '.gz', '.tgz', '.rar', '.7z', '.tar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.webm', '.wav', '.ogg',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.node', '.bin',
]);

function nombreProhibido(ruta) {
  const base = basename(ruta).toLowerCase();
  if (/\.(example|sample|template)$/.test(base)) return false;
  if (/^\.env($|\.)/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  return /\.(key|pem|p12|pfx)$/.test(base);
}

function saltar(ruta) {
  const base = basename(ruta);
  return LOCKFILES.has(base) || BINARIOS.has(extname(base).toLowerCase());
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detalle = err && err.stderr ? String(err.stderr).trim() : String(err && err.message);
    console.error(`ERROR [secretos]: falló \`git ${args.join(' ')}\`: ${detalle}`);
    console.error('Se aborta (falla cerrado): sin diff no hay revisión.');
    process.exit(1);
  }
}

/** Devuelve los tipos de secreto presentes en una línea (nunca el valor). */
function revisarLinea(linea) {
  if (linea.includes(MARCADOR)) return [];
  const tipos = [];
  for (const { tipo, re } of PATRONES) {
    const m = re.exec(linea);
    if (m && !esRelleno(m[0])) tipos.push(tipo);
  }
  for (const m of linea.matchAll(MONGO_URI)) {
    if (!esMarcador(m[3])) {
      tipos.push('URI de MongoDB con contraseña');
      break;
    }
  }
  return tipos;
}

/** Parsea un diff --unified=0 y entrega las líneas añadidas por archivo con su número de línea. */
function lineasAnadidas(diff) {
  const porArchivo = new Map();
  let actual = null;
  let numero = 0;
  for (const linea of diff.split('\n')) {
    if (linea.startsWith('+++ ')) {
      const destino = linea.slice(4).trim();
      actual = destino === '/dev/null' ? null : destino.replace(/^b\//, '');
      if (actual && !porArchivo.has(actual)) porArchivo.set(actual, []);
      continue;
    }
    if (linea.startsWith('@@')) {
      const m = /\+(\d+)/.exec(linea);
      numero = m ? Number(m[1]) : 0;
      continue;
    }
    if (actual && linea.startsWith('+')) {
      porArchivo.get(actual).push({ n: numero, texto: linea.slice(1).replace(/\r$/, '') });
      numero++;
    }
  }
  return porArchivo;
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let modo = 'staged';
let ref = null;
if (args[0] === '--arbol') modo = 'arbol';
else if (args[0] === '--desde') {
  ref = args[1];
  if (!ref) {
    console.error('Uso: node scripts/check-no-secrets.mjs [--desde <ref> | --arbol]');
    process.exit(2);
  }
  modo = `desde ${ref}`;
} else if (args.length > 0) {
  console.error(`Argumento desconocido: ${args[0]}`);
  console.error('Uso: node scripts/check-no-secrets.mjs [--desde <ref> | --arbol]');
  process.exit(2);
}

const raiz = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(raiz);

const hallazgos = [];
let archivos = 0;
let lineas = 0;

if (modo === 'arbol') {
  const rutas = git(['ls-files', '-z']).split('\0').filter(Boolean);
  for (const ruta of rutas) {
    if (nombreProhibido(ruta)) hallazgos.push({ ruta, n: null, tipo: 'archivo sensible versionado' });
    if (saltar(ruta)) continue;
    let contenido;
    try {
      if (!statSync(ruta).isFile()) continue;
      contenido = readFileSync(ruta);
    } catch {
      continue; // borrado en el árbol de trabajo
    }
    if (contenido.subarray(0, 8000).includes(0)) continue; // binario
    archivos++;
    const texto = contenido.toString('utf8').split(/\r?\n/);
    texto.forEach((linea, i) => {
      lineas++;
      for (const tipo of revisarLinea(linea)) hallazgos.push({ ruta, n: i + 1, tipo });
    });
  }
} else {
  const rango = modo === 'staged' ? ['--cached'] : [`${ref}...HEAD`];
  const nombres = git(['diff', ...rango, '--name-only', '-z', '--diff-filter=ACMR']).split('\0').filter(Boolean);
  for (const ruta of nombres) {
    if (nombreProhibido(ruta)) hallazgos.push({ ruta, n: null, tipo: 'archivo sensible en el cambio' });
  }
  const diff = git(['diff', ...rango, '--no-color', '--no-ext-diff', '--unified=0', '--diff-filter=ACMR']);
  for (const [ruta, anadidas] of lineasAnadidas(diff)) {
    if (saltar(ruta)) continue;
    archivos++;
    for (const { n, texto } of anadidas) {
      lineas++;
      for (const tipo of revisarLinea(texto)) hallazgos.push({ ruta, n, tipo });
    }
  }
}

if (hallazgos.length > 0) {
  console.error('ERROR [secretos]: posibles secretos (no se muestra el valor):');
  for (const h of hallazgos) console.error(`   ${h.ruta}${h.n ? `:${h.n}` : ''} — ${h.tipo}`);
  console.error('');
  console.error('Quita el secreto del cambio (usa variables de entorno). Si es un falso positivo,');
  console.error(`añade \`${MARCADOR}\` en esa misma línea y explícalo en el PR.`);
  console.error('Si el secreto ya llegó a un commit, rótalo: borrarlo del archivo no basta.');
}

console.log(`secretos (${modo}): ${archivos} archivos, ${lineas} líneas revisadas, ${hallazgos.length} hallazgos`);
process.exit(hallazgos.length > 0 ? 1 : 0);
