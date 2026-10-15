import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACC } from '../../modules/core-ledger/domain/ledger.constants';

/**
 * Guardián del cambio de cuentas del PUC (ítem 1.3): el IVA va a la 2408 y el
 * INC a la 2495. La 2367 (ReteIVA) y la 2368 (ReteICA) son retenciones
 * practicadas; hasta octubre de 2026 el posteo automático mandaba ahí el
 * impuesto de las ventas y hubo que reclasificarlo con un script.
 *
 * Falla si algún código de producción vuelve a nombrar esas cuentas. Solo se
 * permiten la siembra del plan (nombre PUC real) y la tabla de reclasificación
 * de `ledger.constants.ts`, más los scripts de `src/datos/`, que existen
 * justamente para trasladar el saldo viejo.
 */

const SRC = join(process.cwd(), 'src');

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

const FUENTES = existsSync(SRC)
  ? walk(SRC).filter(
      (f) =>
        f.endsWith('.ts') && !f.endsWith('.spec.ts') && !rel(f).startsWith('datos/'),
    )
  : [];

/** Las cuentas de retención como literal: '2367', "2368", `2367`. */
const CUENTA_RETENCION = /(['"`])236[78]\1/;

/** Usos legítimos: siembra del plan y tabla de reclasificación. */
const PERMITIDO: Record<string, RegExp> = {
  'modules/core-ledger/domain/ledger.constants.ts': /^\s*\{ (code|desde): '236[78]'/,
};

describe('guardián · nada postea IVA/INC en 2367/2368', () => {
  it('revisa el código de producción (si no encuentra archivos, no miró)', () => {
    expect(FUENTES.length).toBeGreaterThan(100);
  });

  it('el posteo automático no tiene la 2367 ni la 2368 entre sus cuentas', () => {
    const codigos = Object.values(ACC) as string[];
    expect(codigos).not.toContain('2367');
    expect(codigos).not.toContain('2368');
  });

  it('ningún archivo fuera de src/datos nombra la 2367 o la 2368', () => {
    const hallazgos: string[] = [];
    for (const file of FUENTES) {
      const permitido = PERMITIDO[rel(file)];
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (esComentario(line) || !CUENTA_RETENCION.test(line)) return;
          if (permitido?.test(line)) return;
          hallazgos.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
        });
    }
    expect(hallazgos, 'IVA va a ACC.IVA_POR_PAGAR (2408) e INC a ACC.INC_POR_PAGAR (2495)').toEqual([]);
  });
});
