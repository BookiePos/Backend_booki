import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guardianes de las tres invariantes de `CLAUDE.md` (permisos, dinero, tenancy).
 *
 * No prueban comportamiento: leen el código fuente y fallan cuando alguien rompe
 * una regla que el compilador no ve. Antes esas reglas solo las vigilaban los
 * agentes auditores, que hay que acordarse de invocar; un test corre siempre.
 *
 * Cada guardián afirma primero CUÁNTO revisó. Uno que no encontró archivos no
 * "pasó": no miró, y por eso falla (un escáner roto que devuelve cero hallazgos
 * es indistinguible de un repo limpio).
 *
 * La deuda que ya existía está congelada en `scripts/techos.json` y solo puede
 * bajar. Subir un techo es posible, pero queda escrito en el diff del PR.
 */

const RAIZ = process.cwd();
const SRC = join(RAIZ, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const rel = (file: string): string => relative(SRC, file).split(sep).join('/');
const esComentario = (line: string): boolean => /^\s*(\*|\/\*|\/\/)/.test(line);

/** Código de producción: todo `.ts` de `src/` que no sea un spec. */
const FUENTES = existsSync(SRC)
  ? walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  : [];

const techos = JSON.parse(
  readFileSync(join(RAIZ, 'scripts', 'techos.json'), 'utf8'),
) as { dineroPorModulo: Record<string, number> };

// ---------------------------------------------------------------------------
// 1. Permisos: deny-by-default, y la lista de endpoints públicos es cerrada
// ---------------------------------------------------------------------------

const HTTP = /^\s*@(Get|Post|Put|Patch|Delete|All)\(/;
const POLITICA = /^\s*@(RequirePermissions|RequireAnyPermission|Public|NoPermissionRequired)\(/;
/** Firma de un método de clase (sangría de 2 espacios, sin `@`). */
const FIRMA = /^ {2}(?:async\s+)?([A-Za-z_]\w*)\s*[(<]/;
/** Línea que cierra el miembro anterior de la clase. */
const FIN_MIEMBRO = /^ {2}\}\s*$|\{\}\s*$|^export class |^ {2}\S.*;\s*$/;

interface Handler {
  id: string;
  politicas: string[];
}

function handlersDe(file: string): Handler[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const claseIdx = lines.findIndex((l) => /^export class /.test(l));
  // Una política puesta sobre la clase vale para todos sus handlers.
  const deClase = lines
    .slice(0, Math.max(claseIdx, 0))
    .filter((l) => POLITICA.test(l))
    .map((l) => POLITICA.exec(l)![1]!);

  const out: Handler[] = [];
  lines.forEach((line, i) => {
    if (!HTTP.test(line)) return;
    let ini = i;
    while (ini > 0 && lines[ini - 1]!.trim() !== '' && !FIN_MIEMBRO.test(lines[ini - 1]!)) {
      ini--;
    }
    let fin = i + 1;
    while (fin < lines.length && !FIRMA.test(lines[fin]!)) fin++;
    const nombre = FIRMA.exec(lines[fin] ?? '')?.[1] ?? `linea${i + 1}`;
    const bloque = lines.slice(ini, fin).filter((l) => !esComentario(l));
    const propias = bloque.filter((l) => POLITICA.test(l)).map((l) => POLITICA.exec(l)![1]!);
    out.push({
      id: `${rel(file)}#${nombre}`,
      politicas: propias.length > 0 ? propias : deClase,
    });
  });
  return out;
}

/**
 * Endpoints sin autenticación. Añadir uno aquí es una decisión de seguridad:
 * debe verse en el diff y pasar por `auditor-permisos`.
 */
const PUBLICOS_PERMITIDOS = [
  'modules/billing/infrastructure/billing.controller.ts#webhook',
  'modules/core-auth/infrastructure/auth.controller.ts#forgotPassword',
  'modules/core-auth/infrastructure/auth.controller.ts#login',
  'modules/core-auth/infrastructure/auth.controller.ts#logout',
  'modules/core-auth/infrastructure/auth.controller.ts#refresh',
  'modules/core-auth/infrastructure/auth.controller.ts#register',
  'modules/core-auth/infrastructure/auth.controller.ts#resetPassword',
  'modules/core-auth/infrastructure/auth.controller.ts#validateReset',
  'modules/core-auth/infrastructure/invitations.controller.ts#accept',
  'modules/core-auth/infrastructure/invitations.controller.ts#getByToken',
  // Sin usuario: lo llama Vercel Cron y lo protege CRON_SECRET (ver cron-auth.ts).
  'modules/cron/infrastructure/cron.controller.ts#diario',
  'modules/health/infrastructure/health.controller.ts#check',
];

describe('guardián · permisos', () => {
  const controllers = FUENTES.filter((f) => f.endsWith('.controller.ts'));
  const handlers = controllers.flatMap(handlersDe);

  it('revisó todos los handlers HTTP (el escáner no se saltó ninguno)', () => {
    const crudos = controllers
      .map((f) => readFileSync(f, 'utf8').match(/^\s*@(Get|Post|Put|Patch|Delete|All)\(/gm))
      .reduce((n, m) => n + (m?.length ?? 0), 0);
    expect(controllers.length).toBeGreaterThan(20);
    expect(crudos).toBeGreaterThan(200);
    expect(handlers.length).toBe(crudos);
  });

  it('cada handler declara exactamente una política', () => {
    const malos = handlers
      .filter((h) => h.politicas.length !== 1)
      .map((h) => `${h.id} → ${h.politicas.length === 0 ? 'ninguna' : h.politicas.join(' + ')}`);
    expect(malos, 'usa @RequirePermissions, @Public o @NoPermissionRequired (solo uno)').toEqual(
      [],
    );
  });

  it('los endpoints @Public son exactamente los de la lista cerrada', () => {
    const publicos = handlers
      .filter((h) => h.politicas.includes('Public'))
      .map((h) => h.id)
      .sort();
    expect(publicos).toEqual([...PUBLICOS_PERMITIDOS].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Dinero: el redondeo vive en money.util.ts, no suelto por los módulos
// ---------------------------------------------------------------------------

const REDONDEO_A_MANO = /Math\.round\(|\.toFixed\(|parseFloat\(/g;
const HELPERS_DE_DINERO = 'modules/finance/domain/money.util.ts';

describe('guardián · dinero', () => {
  const porModulo: Record<string, number> = {};
  const lugares: Record<string, string[]> = {};
  let revisados = 0;

  for (const file of FUENTES) {
    const r = rel(file);
    if (!r.startsWith('modules/') || r === HELPERS_DE_DINERO) continue;
    revisados++;
    const modulo = r.split('/')[1]!;
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (esComentario(line)) return;
        const n = line.match(REDONDEO_A_MANO)?.length ?? 0;
        if (n === 0) return;
        porModulo[modulo] = (porModulo[modulo] ?? 0) + n;
        (lugares[modulo] ??= []).push(`${r}:${i + 1}`);
      });
  }

  it('revisó el código de los módulos', () => {
    expect(revisados).toBeGreaterThan(150);
    expect(existsSync(join(SRC, HELPERS_DE_DINERO))).toBe(true);
  });

  it('ningún módulo redondea a mano más veces que su techo', () => {
    const subieron = Object.entries(porModulo)
      .filter(([m, n]) => n > (techos.dineroPorModulo[m] ?? 0))
      .map(
        ([m, n]) =>
          `${m}: ${n} (techo ${techos.dineroPorModulo[m] ?? 0}) → ${lugares[m]!.join(', ')}`,
      );
    expect(
      subieron,
      'Math.round/toFixed/parseFloat nuevos: usa cop()/sumCop() de money.util.ts. ' +
        'Si es solo presentación (PDF, texto), sube el techo en scripts/techos.json y dilo en el PR',
    ).toEqual([]);
  });

  it('los techos no quedaron holgados (si bajó la cuenta, baja el techo)', () => {
    const holgados = Object.entries(techos.dineroPorModulo)
      .filter(([m, techo]) => (porModulo[m] ?? 0) < techo)
      .map(([m, techo]) => `${m}: hay ${porModulo[m] ?? 0}, el techo dice ${techo}`);
    expect(holgados, 'actualiza dineroPorModulo en scripts/techos.json').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Tenancy: el modelo es un proxy inerte fuera de una request
// ---------------------------------------------------------------------------

/** Devuelve el cuerpo `{ ... }` que empieza en la primera llave tras `desde`. */
function cuerpo(text: string, desde: number): string {
  const abre = text.indexOf('{', desde);
  if (abre < 0) return '';
  let nivel = 0;
  for (let i = abre; i < text.length; i++) {
    if (text[i] === '{') nivel++;
    else if (text[i] === '}' && --nivel === 0) return text.slice(abre, i + 1);
  }
  return '';
}

/** Índice del paréntesis que cierra el que se abre en `abre`. */
function cierraParentesis(text: string, abre: number): number {
  let nivel = 0;
  for (let i = abre; i < text.length; i++) {
    if (text[i] === '(') nivel++;
    else if (text[i] === ')' && --nivel === 0) return i;
  }
  return -1;
}

describe('guardián · tenancy', () => {
  const conModelos = FUENTES.filter((f) => readFileSync(f, 'utf8').includes('@InjectModel('));

  it('revisó los servicios que inyectan modelos', () => {
    expect(conModelos.length).toBeGreaterThan(20);
  });

  it('ningún modelo se consulta en el constructor ni en onModuleInit', () => {
    const malos: string[] = [];
    let modelos = 0;
    for (const file of conModelos) {
      const text = readFileSync(file, 'utf8');
      const nombres = [...text.matchAll(/@InjectModel\([^)]*\)\s*(?:\w+\s+)*?(\w+)\s*:/g)].map(
        (m) => m[1]!,
      );
      modelos += nombres.length;

      const zonas: [string, string][] = [];
      const ctor = text.search(/^\s*constructor\(/m);
      if (ctor >= 0) {
        const fin = cierraParentesis(text, text.indexOf('(', ctor));
        if (fin >= 0) zonas.push(['constructor', cuerpo(text, fin)]);
      }
      for (const m of text.matchAll(/^\s*(?:async\s+)?(onModuleInit|onApplicationBootstrap)\(/gm)) {
        zonas.push([m[1]!, cuerpo(text, m.index!)]);
      }
      for (const [zona, body] of zonas) {
        for (const nombre of nombres) {
          if (new RegExp(`\\bthis\\.${nombre}\\b|(?<![.\\w])${nombre}\\.`).test(body)) {
            malos.push(`${rel(file)} usa ${nombre} en ${zona}`);
          }
        }
      }
    }
    expect(modelos).toBeGreaterThan(50);
    expect(malos, 'fuera de una request el proxy devuelve undefined').toEqual([]);
  });

  it('nadie arma el nombre de la base a mano (usa dbNameForBusiness)', () => {
    const malos: string[] = [];
    for (const file of FUENTES) {
      if (rel(file) === 'shared/tenancy/tenant-context.ts') continue;
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (!esComentario(line) && /[`'"]biz_/.test(line)) malos.push(`${rel(file)}:${i + 1}`);
        });
    }
    expect(malos).toEqual([]);
  });
});
