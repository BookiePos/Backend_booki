import type { Conteo } from './en-cada-empresa';
import {
  fechaCorteDePeriodo,
  horasMesVigentes,
  type PayrollBreakdown,
} from '../modules/payroll/domain/payroll-calc';
import type { PayrollSettingsData } from '../modules/payroll/domain/payroll.constants';
import { cop, sumBy } from '../modules/finance/domain/money.util';

/**
 * Informe del ítem 1.8: nóminas ya liquidadas con un divisor del valor hora
 * distinto al de la jornada vigente en su período (Ley 2101 de 2021, art. 3).
 *
 * Hasta octubre de 2026 el motor dividía siempre por 240 h. Las colillas de esa
 * época no guardan `divisorHoras`: se asume 240. Solo LEE: reliquidar una
 * corrida cerrada es una decisión de nómina (y de PILA/nómina electrónica de
 * ajuste) que no se hace por script.
 *
 * La diferencia que se reporta es la directa en recargos y horas extra. Lo que
 * arrastra (IBC, aportes, retención y provisiones) se recalcula al reliquidar.
 */

/** Divisor con que se liquidó la corrida antes de existir el campo. */
export const DIVISOR_ANTERIOR = 240;

export interface ColillaGuardada {
  employeeName?: string;
  salarioBase: number;
  breakdown: Partial<Pick<PayrollBreakdown, 'divisorHoras'>> & {
    devengados: Pick<PayrollBreakdown['devengados'], 'recargoDetalle'>;
  };
}

export interface CorridaGuardada {
  id: string;
  period: string;
  status: string;
  slips: ColillaGuardada[];
}

export interface DiferenciaCorrida {
  id: string;
  period: string;
  status: string;
  divisorUsado: number;
  divisorCorrecto: number;
  colillas: number;
  colillasConHoras: number;
  /** Recargos + extras con el divisor correcto menos lo liquidado (COP). */
  diferencia: number;
}

/** Recargo/extra de una línea con el divisor indicado (misma regla que computeSlip). */
function valorLinea(
  salarioBase: number,
  divisor: number,
  l: { key: string; horas: number; factor: number },
): number {
  const esExtra = l.key.startsWith('extra');
  const mult = esExtra ? 1 + l.factor : l.factor;
  return cop(l.horas * (salarioBase / divisor) * mult);
}

/** Compara una corrida con el divisor de su período. `null` si no difiere. */
export function diferenciaCorrida(
  run: CorridaGuardada,
  s: PayrollSettingsData,
): DiferenciaCorrida | null {
  const divisorCorrecto = horasMesVigentes(fechaCorteDePeriodo(run.period), s);
  const divisorUsado =
    run.slips.find((c) => c.breakdown?.divisorHoras)?.breakdown.divisorHoras ??
    DIVISOR_ANTERIOR;
  if (divisorUsado === divisorCorrecto) return null;

  let colillasConHoras = 0;
  const diferencia = sumBy(run.slips, (c) => {
    const lineas = c.breakdown?.devengados?.recargoDetalle ?? [];
    if (lineas.length === 0) return 0;
    colillasConHoras += 1;
    return sumBy(
      lineas,
      (l) =>
        valorLinea(c.salarioBase, divisorCorrecto, l) -
        valorLinea(c.salarioBase, divisorUsado, l),
    );
  });

  return {
    id: run.id,
    period: run.period,
    status: run.status,
    divisorUsado,
    divisorCorrecto,
    colillas: run.slips.length,
    colillasConHoras,
    diferencia,
  };
}

/** Conteo de la empresa para el resumen de `enCadaEmpresa`. */
export function contarDivisor(diferencias: DiferenciaCorrida[]): Conteo {
  return {
    corridasConOtroDivisor: diferencias.length,
    cerradas: diferencias.filter((d) => d.status === 'cerrada').length,
    colillasConHoras: sumBy(diferencias, (d) => d.colillasConHoras),
    diferenciaCop: sumBy(diferencias, (d) => d.diferencia),
  };
}
