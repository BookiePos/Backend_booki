/**
 * Cierre anual del libro (riesgo R4 de la revisión contable 1.16).
 *
 * Sin cierre, el balance general sumaba los ingresos y gastos de TODOS los
 * años en «Resultado del ejercicio»: en el segundo año, la utilidad del
 * primero aparecía como si fuera del ejercicio actual. El dueño decidió un
 * cierre MANUAL desde el panel (no automático): lo dispara quien tiene
 * `finance.manage`, cuando el contador le da el visto bueno al año.
 *
 * El cierre son dos asientos, por sede (cada renglón conserva su sede para
 * que los informes por sede sigan cuadrando):
 *
 * 1. `cierre_anual`, fechado el 31 de diciembre del año: cancela cada cuenta
 *    de resultados (4, 5, 6 y 7) contra la 3605 «Resultado del ejercicio».
 *    El balance general al 31 de diciembre muestra la utilidad en la 3605.
 * 2. `cierre_anual_traslado`, fechado el 1 de enero del año siguiente: lleva
 *    la 3605 a la 3705 «Resultados de ejercicios anteriores». Desde ahí, el
 *    balance de cualquier fecha del año nuevo separa lo de años anteriores
 *    del resultado del ejercicio en curso (NIIF Pymes 4.11 y 6.3).
 *
 * El asiento 1 no entra al estado de resultados (lo excluye
 * `ORIGENES_FUERA_DE_RESULTADOS`): si entrara, el estado de resultados de
 * cualquier rango que incluya el 31 de diciembre saldría en cero.
 *
 * Reglas puras, sin Nest ni Mongoose. La orquestación vive en
 * `application/cierre-anual.service.ts`.
 */

import { ACC } from './ledger.constants';

export const ORIGEN_CIERRE = 'cierre_anual';
export const ORIGEN_TRASLADO = 'cierre_anual_traslado';

/** Origenes del cierre: el sistema los postea, un asiento manual no. */
export const ORIGENES_CIERRE: readonly string[] = [ORIGEN_CIERRE, ORIGEN_TRASLADO];

/**
 * Asientos que no son operación del periodo y no van al estado de resultados.
 * La reversa del cierre (al reabrir el año) tampoco: se anulan entre sí.
 */
export const ORIGENES_FUERA_DE_RESULTADOS: readonly string[] = [
  ORIGEN_CIERRE,
  `reversal:${ORIGEN_CIERRE}`,
];

/** Saldo de una cuenta de resultados en una sede (null = nivel empresa). */
export interface SaldoResultado {
  code: string;
  type: 'income' | 'expense';
  sedeId: string | null;
  debit: number;
  credit: number;
}

/** Renglón listo para `LedgerService.post`. */
export interface RenglonCierre {
  accountCode: string;
  debit?: number;
  credit?: number;
  sedeId?: string;
  memo?: string;
}

export interface CierreArmado {
  /** Renglones del asiento `cierre_anual`. Vacío si no hay nada que cerrar. */
  renglones: RenglonCierre[];
  /** Utilidad (+) o pérdida (−) del año: Σ créditos − Σ débitos de resultados. */
  resultado: number;
}

/**
 * Arma el asiento de cierre: cada cuenta de resultados con saldo se cancela
 * por su lado contrario, y la diferencia de cada sede va a la 3605 (crédito
 * si hubo utilidad, débito si hubo pérdida). Todo es entero COP: no hay
 * divisiones, así que cada sede cuadra exacta por construcción.
 */
export function armarCierre(saldos: readonly SaldoResultado[]): CierreArmado {
  const renglones: RenglonCierre[] = [];
  const resultadoPorSede = new Map<string | null, number>();
  const ordenados = [...saldos].sort((a, b) =>
    `${a.sedeId ?? ''}|${a.code}` < `${b.sedeId ?? ''}|${b.code}` ? -1 : 1,
  );
  for (const s of ordenados) {
    const neto = s.debit - s.credit;
    if (neto === 0) continue;
    const sede = s.sedeId ?? undefined;
    renglones.push(
      neto > 0
        ? { accountCode: s.code, credit: neto, sedeId: sede }
        : { accountCode: s.code, debit: -neto, sedeId: sede },
    );
    resultadoPorSede.set(s.sedeId, (resultadoPorSede.get(s.sedeId) ?? 0) - neto);
  }
  let resultado = 0;
  for (const [sedeId, r] of resultadoPorSede) {
    resultado += r;
    if (r === 0) continue;
    const sede = sedeId ?? undefined;
    renglones.push(
      r > 0
        ? { accountCode: ACC.RESULTADO_EJERCICIO, credit: r, sedeId: sede }
        : { accountCode: ACC.RESULTADO_EJERCICIO, debit: -r, sedeId: sede },
    );
  }
  return { renglones, resultado };
}

/**
 * Traslado de la 3605 a la 3705, a partir de los renglones de la 3605 que
 * dejó el cierre. Vacío si el año dio exactamente cero en todas las sedes.
 */
export function armarTraslado(
  renglones3605: readonly { debit?: number; credit?: number; sedeId?: unknown }[],
): RenglonCierre[] {
  const out: RenglonCierre[] = [];
  for (const l of renglones3605) {
    const sede = l.sedeId != null ? String(l.sedeId) : undefined;
    // Tolera el renglón tal como se armó (sin el lado en cero) o ya guardado.
    const r = (l.credit ?? 0) - (l.debit ?? 0);
    if (r === 0) continue;
    if (r > 0) {
      out.push({ accountCode: ACC.RESULTADO_EJERCICIO, debit: r, sedeId: sede });
      out.push({ accountCode: ACC.RESULTADOS_ANTERIORES, credit: r, sedeId: sede });
    } else {
      out.push({ accountCode: ACC.RESULTADO_EJERCICIO, credit: -r, sedeId: sede });
      out.push({ accountCode: ACC.RESULTADOS_ANTERIORES, debit: -r, sedeId: sede });
    }
  }
  return out;
}

/** Año YYYY válido para cerrar o reabrir (entero de 4 cifras). */
export function anioValido(anio: string): number | null {
  if (!/^\d{4}$/.test(anio)) return null;
  const n = Number(anio);
  return n >= 2000 && n <= 2999 ? n : null;
}

export const finDeAnio = (anio: number) => `${anio}-12-31`;
export const inicioDeAnio = (anio: number) => `${anio}-01-01`;
