import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from './permissions';
import { ROLES, SYSTEM_ROLES } from './roles';

/**
 * Ítem 3.10: matriz de permisos por rol del sistema.
 *
 * Lee cada handler HTTP con su política y calcula qué rol de sistema lo puede
 * llamar con los permisos de código (los de un rol sin editar). El resultado se
 * guarda en `docs/MATRIZ-PERMISOS.md`: un permiso nuevo, un endpoint nuevo o un
 * cambio en `roles.ts` cambia ese archivo y el cambio se ve en el diff del PR.
 * En CI un archivo desactualizado hace fallar la prueba; en local se regenera
 * con `pnpm vitest run matriz-permisos -u`.
 *
 * El guardián de `invariantes.guard.spec.ts` ya exige una política por handler;
 * aquí se mira a quién deja pasar cada una.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

type Politica =
  | { tipo: 'publico' }
  | { tipo: 'sesion' }
  | { tipo: 'permisos'; permisos: string[] }
  | { tipo: 'alguno'; permisos: string[] };

interface Endpoint {
  ruta: string;
  politica: Politica;
}

const HTTP = /^\s*@(Get|Post|Put|Patch|Delete|All)\((?:'([^']*)')?/;
const FIRMA = /^ {2}(?:async\s+)?[A-Za-z_]\w*\s*[(<]/;
const FIN_MIEMBRO = /^ {2}\}\s*$|\{\}\s*$|^export class |^ {2}\S.*;\s*$/;

/** `PERMISSIONS.ALGO` → la cadena estable `modulo.accion`. */
function permisosDe(texto: string): string[] {
  return [...texto.matchAll(/PERMISSIONS\.([A-Z_]+)/g)].map(([, clave]) => {
    const valor = (PERMISSIONS as Record<string, string>)[clave!];
    if (!valor) throw new Error(`PERMISSIONS.${clave} no existe`);
    return valor;
  });
}

function politicaDe(bloque: string): Politica | null {
  if (/@Public\(/.test(bloque)) return { tipo: 'publico' };
  if (/@NoPermissionRequired\(/.test(bloque)) return { tipo: 'sesion' };
  const req = /@RequirePermissions\(([\s\S]*?)\)\s*(?:\n|$)/.exec(bloque);
  if (req) return { tipo: 'permisos', permisos: permisosDe(req[1]!) };
  const alguno = /@RequireAnyPermission\(([\s\S]*?)\)\s*(?:\n|$)/.exec(bloque);
  return alguno ? { tipo: 'alguno', permisos: permisosDe(alguno[1]!) } : null;
}

function endpointsDe(file: string): Endpoint[] {
  const texto = readFileSync(file, 'utf8');
  const lines = texto.split(/\r?\n/);
  const prefijo = /@Controller\((?:'([^']*)')?/.exec(texto)?.[1] ?? '';
  const claseIdx = lines.findIndex((l) => /^export class /.test(l));
  const deClase = politicaDe(lines.slice(0, Math.max(claseIdx, 0)).join('\n'));

  const out: Endpoint[] = [];
  lines.forEach((line, i) => {
    const http = HTTP.exec(line);
    if (!http) return;
    let ini = i;
    while (ini > 0 && lines[ini - 1]!.trim() !== '' && !FIN_MIEMBRO.test(lines[ini - 1]!)) {
      ini--;
    }
    let fin = i + 1;
    while (fin < lines.length && !FIRMA.test(lines[fin]!)) fin++;
    const bloque = lines
      .slice(ini, fin)
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');
    const politica = politicaDe(bloque) ?? deClase;
    if (!politica) throw new Error(`${file}:${i + 1} sin política`);
    const ruta = ['', prefijo, http[2] ?? ''].filter(Boolean).join('/');
    out.push({ ruta: `${http[1]!.toUpperCase()} /${ruta.replace(/^\/+/, '')}`, politica });
  });
  return out;
}

const ENDPOINTS = walk(SRC)
  .filter((f) => f.endsWith('.controller.ts'))
  .sort((a, b) => relative(SRC, a).localeCompare(relative(SRC, b)))
  .flatMap(endpointsDe);

const ROL = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.key, new Set<string>(r.permissions)]));

/** Igual que `PermissionsGuard`: TODOS los pedidos, o UNO con `@RequireAnyPermission`. */
function puede(rol: string, e: Endpoint): boolean {
  if (e.politica.tipo === 'alguno') return e.politica.permisos.some((p) => ROL[rol]!.has(p));
  if (e.politica.tipo !== 'permisos') return true;
  return e.politica.permisos.every((p) => ROL[rol]!.has(p));
}

/** Pide algún permiso (no es público ni basta la sesión). */
const conPermiso = (e: Endpoint): boolean =>
  e.politica.tipo === 'permisos' || e.politica.tipo === 'alguno';

const puedeRuta =(rol: string, ruta: string): boolean => {
  const e = ENDPOINTS.find((x) => x.ruta === ruta);
  if (!e) throw new Error(`No existe el endpoint ${ruta}`);
  return puede(rol, e);
};

const COLUMNAS = [
  ROLES.OWNER,
  ROLES.ADMIN,
  ROLES.MANAGER,
  ROLES.CASHIER,
  ROLES.ACCOUNTANT,
] as const;

function matrizMarkdown(): string {
  const nombre = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.key, r.name]));
  const filas = ENDPOINTS.map((e) => {
    const quien =
      e.politica.tipo === 'publico'
        ? 'público'
        : e.politica.tipo === 'sesion'
          ? 'con sesión'
          : e.politica.permisos
              .map((p) => `\`${p}\``)
              .join(e.politica.tipo === 'alguno' ? ' o ' : ' + ');
    const marcas = COLUMNAS.map((r) => (puede(r, e) ? '✓' : '·'));
    return `| \`${e.ruta}\` | ${quien} | ${marcas.join(' | ')} |`;
  });
  return [
    '# Matriz de permisos',
    '',
    'Generada por `src/modules/core-auth/domain/matriz-permisos.spec.ts` (ítem 3.10).',
    'No se edita a mano: se regenera con `pnpm vitest run matriz-permisos -u`.',
    '',
    'Cada fila es un endpoint con el permiso que exige y los roles de sistema que',
    'pasan con sus permisos de código (un rol que nadie ha editado). Un rol editado',
    'en la empresa, o un usuario con permisos extra, puede salirse de esta tabla.',
    'Además del permiso, cada servicio limita por sede a quien no ve todas.',
    '',
    `| Endpoint | Exige | ${COLUMNAS.map((r) => nombre[r]).join(' | ')} |`,
    `|---|---|${COLUMNAS.map(() => ':-:').join('|')}|`,
    ...filas,
    '',
  ].join('\n');
}

describe('matriz de permisos por rol (ítem 3.10)', () => {
  it('leyó todos los controladores', () => {
    expect(ENDPOINTS.length).toBeGreaterThan(200);
  });

  it('la matriz publicada coincide con el código', async () => {
    await expect(matrizMarkdown()).toMatchFileSnapshot('../../../../docs/MATRIZ-PERMISOS.md');
  });

  it('el Dueño entra a todo', () => {
    expect(ENDPOINTS.filter((e) => !puede(ROLES.OWNER, e)).map((e) => e.ruta)).toEqual([]);
  });

  it('el Administrador entra a todo salvo ver todas las sedes', () => {
    const fuera = ENDPOINTS.filter((e) => !puede(ROLES.ADMIN, e));
    for (const e of fuera) {
      expect(e.politica).toMatchObject({ permisos: expect.arrayContaining([PERMISSIONS.SEDE_VIEW_ALL]) });
    }
  });

  it('el Cajero vende y opera su caja, pero no administra', () => {
    for (const ruta of ['POST /sales', 'POST /caja/open', 'POST /caja/close', 'GET /customers']) {
      expect(puedeRuta(ROLES.CASHIER, ruta), ruta).toBe(true);
    }
    const prohibidos = ENDPOINTS.filter((e) =>
      /^\w+ \/(users|roles|invitations|payroll|ledger|billing|audit|finance|employees)\b/.test(
        e.ruta,
      ),
    ).filter((e) => conPermiso(e) && puede(ROLES.CASHIER, e));
    // A propósito: nombre y documento de los empleados activos, para cargarles
    // un consumo (fiado) desde el POS. Sin salario ni datos de contacto.
    expect(prohibidos.map((e) => e.ruta)).toEqual(['GET /employees/lookup']);
    expect(puedeRuta(ROLES.CASHIER, 'POST /sales/:id/void')).toBe(false);
  });

  it('el Gerente opera la sede, pero no toca usuarios, roles, suscripción ni liquida nómina', () => {
    for (const ruta of [
      'POST /sales/:id/void',
      'POST /inventory/adjustments',
      'GET /employees',
      'POST /payroll/deductions/:id/approve',
      // Sin la cola no hay qué aprobar: antes exigía `payroll.view` y daba 403.
      'GET /payroll/deductions',
    ]) {
      expect(puedeRuta(ROLES.MANAGER, ruta), ruta).toBe(true);
    }
    const prohibidos = ENDPOINTS.filter((e) =>
      /^\w+ \/(users|roles|invitations|billing)\b/.test(e.ruta),
    ).filter((e) => conPermiso(e) && puede(ROLES.MANAGER, e));
    expect(prohibidos.map((e) => e.ruta)).toEqual([]);
    for (const ruta of ['POST /payroll/runs', 'POST /employees', 'PUT /payroll/settings']) {
      expect(puedeRuta(ROLES.MANAGER, ruta), ruta).toBe(false);
    }
  });

  it('el Contador lee lo contable y no escribe nada ni toca la operación (ítem 7.8)', () => {
    for (const ruta of [
      'GET /ledger/entries',
      'GET /ledger/trial-balance',
      'GET /ledger/conciliacion',
      'GET /reports/income-statement',
      'GET /reports/balance-sheet',
      'GET /finance/expenses',
      'GET /finance/payables',
      'GET /purchasing/orders',
      'GET /invoice-scans',
      'GET /payroll/runs',
      'GET /payroll/runs/:id',
    ]) {
      expect(puedeRuta(ROLES.ACCOUNTANT, ruta), ruta).toBe(true);
    }
    // Todo lo que alcanza con permiso es lectura, salvo los dos cálculos de
    // nómina que solo devuelven un resultado y no guardan nada.
    const noLectura = ENDPOINTS.filter((e) => conPermiso(e) && puede(ROLES.ACCOUNTANT, e))
      .filter((e) => !e.ruta.startsWith('GET '))
      .map((e) => e.ruta);
    expect(noLectura).toEqual(['POST /payroll/preview', 'POST /payroll/liquidacion']);
    for (const ruta of [
      'POST /sales',
      'POST /sales/:id/void',
      'POST /caja/open',
      'POST /ledger/entries',
      'POST /finance/expenses',
      'POST /purchasing/orders',
      'POST /payroll/runs',
      'PUT /payroll/settings',
      'POST /invoice-scans/:id/apply',
      'POST /inventory/adjustments',
    ]) {
      expect(puedeRuta(ROLES.ACCOUNTANT, ruta), ruta).toBe(false);
    }
    const prohibidos = ENDPOINTS.filter((e) =>
      /^\w+ \/(users|roles|invitations|billing|audit|params|sedes|taxes|einvoicing|onboarding|employees)\b/.test(
        e.ruta,
      ),
    ).filter((e) => conPermiso(e) && puede(ROLES.ACCOUNTANT, e));
    expect(prohibidos.map((e) => e.ruta)).toEqual([]);
  });

  it('el Contador no recibe permisos de escritura ni de administración', () => {
    const rol = SYSTEM_ROLES.find((r) => r.key === ROLES.ACCOUNTANT)!;
    expect(rol.permissions).toEqual([
      PERMISSIONS.FINANCE_VIEW,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.PAYROLL_VIEW,
      // Solo lectura de toda la empresa (consolidado para el contador externo).
      PERMISSIONS.SEDE_VIEW_ALL,
    ]);
  });
});
