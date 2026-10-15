/**
 * Alcance por sede sobre el libro contable.
 *
 * El asiento no tiene sede propia: la llevan sus renglones (`lines[].sedeId`),
 * y un renglón sin sede es de nivel empresa (nómina, gastos generales,
 * apertura…). De ahí salen las dos reglas de este archivo:
 *
 * - Un asiento entra en el alcance de un usuario limitado por sede solo si
 *   TODOS sus renglones caen en sedes suyas. Mostrarle un asiento mixto le
 *   enseñaría los renglones de la otra sede o los de la empresa.
 * - El balance de comprobación sí se puede partir por sede, porque se agrega
 *   renglón a renglón: el de varias sedes es la suma de los de cada una.
 */

/** Lo mínimo de un renglón para decidir su sede (asiento guardado o DTO). */
export interface LineaConSede {
  sedeId?: unknown;
}

/** ¿Todos los renglones caen en alguna de estas sedes? Sin renglones: no. */
export function lineasEnSedes(
  lines: readonly LineaConSede[],
  sedeIds: readonly string[],
): boolean {
  return (
    lines.length > 0 &&
    lines.every(
      (l) => l.sedeId != null && sedeIds.includes(String(l.sedeId)),
    )
  );
}

/** Lo que se suma de un renglón del balance de comprobación. */
export interface FilaBalance {
  code: string;
  debit: number;
  credit: number;
  balance: number;
}

/** Forma del balance de comprobación que devuelve el ledger. */
export interface BalanceComprobacion<R extends FilaBalance> {
  from?: string;
  to?: string;
  rows: R[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

/**
 * Balance de comprobación restringido a unas sedes.
 *
 * `sedeIds === null` es sin filtro (ve todas). Con una sede se pide tal cual;
 * con varias se pide una por una y se suman cuenta a cuenta (débitos, créditos
 * y saldo son aditivos: son enteros COP, la suma no redondea nada). Con
 * ninguna sale vacío, nunca la empresa entera.
 */
export async function balancePorSedes<R extends FilaBalance>(
  run: (q: {
    from?: string;
    to?: string;
    sedeId?: string;
  }) => Promise<BalanceComprobacion<R>>,
  query: { from?: string; to?: string },
  sedeIds: readonly string[] | null,
): Promise<BalanceComprobacion<R>> {
  if (sedeIds === null) return run(query);
  if (sedeIds.length === 1) return run({ ...query, sedeId: sedeIds[0] });

  const partes = await Promise.all(
    sedeIds.map((sedeId) => run({ ...query, sedeId })),
  );
  const porCuenta = new Map<string, R>();
  let totalDebit = 0;
  let totalCredit = 0;
  for (const parte of partes) {
    totalDebit += parte.totalDebit;
    totalCredit += parte.totalCredit;
    for (const fila of parte.rows) {
      const previa = porCuenta.get(fila.code);
      porCuenta.set(
        fila.code,
        previa
          ? {
              ...previa,
              debit: previa.debit + fila.debit,
              credit: previa.credit + fila.credit,
              balance: previa.balance + fila.balance,
            }
          : { ...fila },
      );
    }
  }
  const rows = [...porCuenta.values()].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  return {
    from: query.from,
    to: query.to,
    rows,
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
  };
}
