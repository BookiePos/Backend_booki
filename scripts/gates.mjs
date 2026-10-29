#!/usr/bin/env node
// gates.mjs — corre los gates del backend y los compara con scripts/techos.json.
//
// Uso:
//   node scripts/gates.mjs              tsc (código y tests), vitest, eslint, secretos
//   node scripts/gates.mjs --build      además `pnpm build` (lo usa el CI)
//   node scripts/gates.mjs --techos <ruta>   usa otro archivo de techos (para probar el propio gate)
//
// Reglas:
//   - La deuda existente se congela con TECHOS que solo pueden bajar. Si la cuenta sube, FALLA.
//     Si baja, también FALLA: pide bajar el techo para que la mejora quede fijada.
//   - Un gate que no consigue una cifra es SIN MEDIR, y eso también es fallo. Un gate que
//     "sale verde" sin haber mirado nada es peor que no tenerlo.
//   - La salida completa de cada gate va a un log en el directorio temporal del sistema;
//     aquí solo se imprime una línea por gate (y la ruta del log si falla).
//
// Es Node puro para que corra igual en Windows y en Linux/CI.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ES_WINDOWS = process.platform === 'win32';
const SELLO = `${Date.now()}-${process.pid}`;

const args = process.argv.slice(2);
const conBuild = args.includes('--build');
const iTechos = args.indexOf('--techos');
const rutaTechos = iTechos >= 0 ? resolve(args[iTechos + 1] ?? '') : join(RAIZ, 'scripts', 'techos.json');

let techos;
try {
  techos = JSON.parse(readFileSync(rutaTechos, 'utf8'));
} catch (err) {
  console.error(`No pude leer los techos (${rutaTechos}): ${err.message}`);
  process.exit(1);
}

/** Corre un comando con la salida a un log temporal. Devuelve { codigo, salida, log }. */
function correr(nombre, comando, argumentos, { shell = ES_WINDOWS } = {}) {
  const log = join(tmpdir(), `gates-${nombre}-${SELLO}.log`);
  const r = spawnSync(comando, argumentos, {
    cwd: RAIZ,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // En Windows `pnpm` es un .cmd y sin shell spawn no lo encuentra. Para `node` se
    // desactiva: su ruta (C:\Program Files\...) tiene espacios y el shell la parte en dos.
    shell,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const salida = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[gates] ${r.error.message}\n` : ''}`;
  writeFileSync(log, `$ ${comando} ${argumentos.join(' ')}\n\n${salida}`);
  return { codigo: r.status, salida, log };
}

function leerJson(ruta) {
  try {
    return JSON.parse(readFileSync(ruta, 'utf8'));
  } catch {
    return null;
  } finally {
    if (existsSync(ruta)) rmSync(ruta, { force: true });
  }
}

/** Compara una cuenta con su techo. */
function contraTecho(cuenta, clave) {
  const techo = techos[clave];
  if (typeof techo !== 'number') return { estado: 'FALLA', nota: `falta el techo «${clave}» en techos.json` };
  if (cuenta > techo) return { estado: 'FALLA', nota: `techo ${techo}: la cuenta SUBIÓ` };
  if (cuenta < techo) return { estado: 'FALLA', nota: `techo ${techo} holgado: baja «${clave}» a ${cuenta}` };
  return { estado: 'OK', nota: `techo ${techo}` };
}

const resultados = [];

function registrar(nombre, cifra, estado, nota, log) {
  resultados.push({ nombre, cifra, estado, nota, log });
}

// --- tsc ---------------------------------------------------------------------
function gateTsc(nombre, clave, argsTsc) {
  const r = correr(nombre, 'pnpm', ['exec', 'tsc', ...argsTsc, '--noEmit', '--pretty', 'false']);
  const errores = (r.salida.match(/error TS\d+/g) ?? []).length;
  // Código distinto de 0 sin un solo «error TSxxxx» = tsc no llegó a compilar (config rota,
  // binario ausente): no hay cifra.
  if (r.codigo === null || (r.codigo !== 0 && errores === 0)) {
    registrar(nombre, '—', 'SIN MEDIR', `tsc salió con ${r.codigo} sin listar errores`, r.log);
    return;
  }
  const { estado, nota } = contraTecho(errores, clave);
  registrar(nombre, `${errores} errores`, estado, nota, r.log);
}

gateTsc('tsc-codigo', 'tscCodigo', ['-p', 'tsconfig.build.json']);
gateTsc('tsc-tests', 'tscConTests', ['-p', 'tsconfig.json']);

// --- cobertura ---------------------------------------------------------------
// Ítem 5.1. Al revés que los techos: el PISO solo sube. Si la cobertura de
// líneas baja del piso, FALLA; si lo supera por un punto o más, también falla
// y pide subirlo, para que la mejora quede fijada.
function gateCobertura(ruta, log) {
  const rep = existsSync(ruta) ? leerJson(ruta) : null;
  const pct = rep?.total?.lines?.pct;
  if (typeof pct !== 'number') {
    registrar('cobertura', '—', 'SIN MEDIR', 'no hubo resumen de cobertura', log);
    return;
  }
  const piso = techos.coberturaLineasPiso;
  const cifra = `${pct.toFixed(2)} % de líneas`;
  if (typeof piso !== 'number') {
    registrar('cobertura', cifra, 'FALLA', 'falta «coberturaLineasPiso» en techos.json', log);
  } else if (pct < piso) {
    registrar('cobertura', cifra, 'FALLA', `piso ${piso}: la cobertura BAJÓ`, log);
  } else if (pct >= piso + 2) {
    // El piso se fija un punto por debajo de la cifra real: con varios PR en
    // paralelo, un piso pegado a la cobertura rompe main por pocas líneas.
    registrar('cobertura', cifra, 'FALLA', `piso ${piso} holgado: sube «coberturaLineasPiso» a ${Math.floor(pct) - 1}`, log);
  } else {
    registrar('cobertura', cifra, 'OK', `piso ${piso}`, log);
  }
}

// --- vitest ------------------------------------------------------------------
{
  const json = join(tmpdir(), `gates-vitest-${SELLO}.json`);
  const dirCobertura = join(tmpdir(), `gates-cobertura-${SELLO}`);
  const r = correr('vitest', 'pnpm', [
    'exec', 'vitest', 'run', '--reporter=json', `--outputFile=${json}`,
    '--coverage.enabled', '--coverage.reporter=json-summary',
    `--coverage.reportsDirectory=${dirCobertura}`,
  ]);
  const rep = leerJson(json);
  gateCobertura(join(dirCobertura, 'coverage-summary.json'), r.log);
  rmSync(dirCobertura, { recursive: true, force: true });
  const total = rep?.numTotalTests ?? 0;
  if (!rep || total === 0) {
    registrar('vitest', '—', 'SIN MEDIR', rep ? '0 tests ejecutados' : 'no hubo reporte json', r.log);
  } else {
    const pasan = rep.numPassedTests ?? 0;
    const fallan = rep.numFailedTests ?? 0;
    const omitidos = (rep.numPendingTests ?? 0) + (rep.numTodoTests ?? 0);
    // Un archivo de test que no carga no suma tests fallidos, pero deja success=false.
    const suitesRotas = rep.numFailedTestSuites ?? 0;
    const ok = fallan === 0 && suitesRotas === 0 && rep.success !== false;
    registrar(
      'vitest',
      `${pasan} pasan, ${fallan} fallan, ${omitidos} omitidos`,
      ok ? 'OK' : 'FALLA',
      suitesRotas > 0 ? `${suitesRotas} archivos de test con fallos` : '',
      r.log,
    );
  }
}

// --- eslint ------------------------------------------------------------------
{
  const json = join(tmpdir(), `gates-eslint-${SELLO}.json`);
  const r = correr('eslint', 'pnpm', ['exec', 'eslint', '.', '-f', 'json', '-o', json]);
  const rep = leerJson(json);
  if (!Array.isArray(rep) || (r.codigo !== 0 && r.codigo !== 1)) {
    registrar('eslint', '—', 'SIN MEDIR', `eslint salió con ${r.codigo}`, r.log);
  } else {
    const errores = rep.reduce((s, f) => s + (f.errorCount ?? 0), 0);
    const avisos = rep.reduce((s, f) => s + (f.warningCount ?? 0), 0);
    const { estado, nota } = contraTecho(errores, 'lintErrores');
    registrar('eslint', `${errores} errores, ${avisos} avisos (${rep.length} archivos)`, estado, nota, r.log);
  }
}

// --- secretos ----------------------------------------------------------------
{
  const r = correr('secretos', process.execPath, [join('scripts', 'check-no-secrets.mjs'), '--arbol'], {
    shell: false,
  });
  const m = /secretos \(arbol\): (\d+) archivos, (\d+) líneas revisadas, (\d+) hallazgos/.exec(r.salida);
  if (!m) {
    registrar('secretos', '—', 'SIN MEDIR', `el script salió con ${r.codigo} sin imprimir su resumen`, r.log);
  } else {
    const hallazgos = Number(m[3]);
    const ok = hallazgos === 0 && r.codigo === 0;
    registrar('secretos', `${hallazgos} hallazgos (${m[1]} archivos)`, ok ? 'OK' : 'FALLA', '', r.log);
  }
}

// --- build (solo con --build) ------------------------------------------------
if (conBuild) {
  const r = correr('build', 'pnpm', ['build']);
  const errores = (r.salida.match(/error TS\d+/g) ?? []).length;
  if (r.codigo === null) {
    registrar('build', '—', 'SIN MEDIR', 'no se pudo lanzar pnpm build', r.log);
  } else {
    registrar('build', `exit ${r.codigo}, ${errores} errores`, r.codigo === 0 ? 'OK' : 'FALLA', '', r.log);
  }
}

// --- informe -----------------------------------------------------------------
const ancho = Math.max(...resultados.map((r) => r.nombre.length));
for (const r of resultados) {
  const nota = r.nota ? `  [${r.nota}]` : '';
  console.log(`${r.estado.padEnd(9)} ${r.nombre.padEnd(ancho)}  ${r.cifra}${nota}`);
  if (r.estado !== 'OK') console.log(`          log: ${r.log}`);
  else rmSync(r.log, { force: true }); // el log de un gate verde no le sirve a nadie
}
const malos = resultados.filter((r) => r.estado !== 'OK').length;
console.log(malos === 0 ? `gates: ${resultados.length}/${resultados.length} OK` : `gates: ${malos} de ${resultados.length} NO pasan`);
process.exit(malos === 0 ? 0 : 1);
