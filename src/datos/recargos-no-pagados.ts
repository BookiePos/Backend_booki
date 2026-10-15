import type { Conteo } from './en-cada-empresa';
import {
  computeSlip,
  fechaCorteDePeriodo,
  jornadaSemanalVigente,
  type ArlLevel,
  type SalaryType,
} from '../modules/payroll/domain/payroll-calc';
import type { PayrollSettingsData } from '../modules/payroll/domain/payroll.constants';
import {
  classifyTurnos,
  type TurnoRecord,
} from '../modules/payroll/domain/turnos-classify';
import { sumBy } from '../modules/finance/domain/money.util';

/**
 * Informe del ítem 1.18: recargos (nocturno, dominical/festivo) y horas extra
 * que Turnos registró y que las nóminas ya liquidadas no pagaron, porque hasta
 * octubre de 2026 las corridas reales no pasaban las horas a `computeSlip`.
 *
 * Solo LEE. Reliquidar es una decisión de nómina con consecuencias fuera del
 * sistema: el mayor valor sube el IBC, así que exige PILA de corrección (tipo N)
 * por cada período, y la nómina electrónica ya transmitida exige una nota de
 * ajuste. Por eso `aplicar` falla siempre.
 *
 * La diferencia que se reporta es la directa (recargos + extras). El IBC
 * adicional se informa para dimensionar la PILA de corrección; aportes,
 * retención y provisiones se recalculan al reliquidar.
 */

export interface ColillaLiquidada {
  employeeId: string;
  employeeName?: string;
  salarioBase: number;
  salaryType?: string;
  arlRiskLevel?: string;
  diasTrabajados: number;
  breakdown: {
    devengados: { recargos?: number; horasExtra?: number };
  };
}

export interface CorridaLiquidada {
  id: string;
  period: string;
  status: string;
  slips: ColillaLiquidada[];
}

export interface TurnoDeEmpleado extends TurnoRecord {
  employeeId: string;
}

export interface NoPagado {
  corridaId: string;
  period: string;
  status: string;
  employeeId: string;
  employeeName?: string;
  horas: number;
  pagado: number;
  debido: number;
  /** Recargos + extras debidos menos los liquidados (COP). */
  diferencia: number;
  /** IBC adicional del período (base de la PILA de corrección). */
  ibcAdicional: number;
}

/**
 * Compara cada colilla con las horas de Turnos de su período. `turnos` debe
 * traer los registros desde el lunes de la semana del día 1 (`lunesDe`), para
 * que el tope semanal de la jornada cuente la semana completa. Devuelve solo
 * las colillas con diferencia.
 */
export function noPagadoCorrida(
  run: CorridaLiquidada,
  turnos: TurnoDeEmpleado[],
  s: PayrollSettingsData,
): NoPagado[] {
  const desde = `${run.period}-01`;
  const fechaCorte = fechaCorteDePeriodo(run.period);
  const out: NoPagado[] = [];
  for (const c of run.slips) {
    const clasif = classifyTurnos(
      turnos.filter((t) => t.employeeId === c.employeeId && t.workDate <= fechaCorte),
      { desde, jornadaSemanal: (f) => jornadaSemanalVigente(f, s) },
    );
    const horas = Object.values(clasif.horas).reduce((a, h) => a + h, 0);
    if (horas <= 0) continue;

    // Mismo cálculo que la corrida, con los días que se liquidaron.
    const base = {
      salarioBase: c.salarioBase,
      salaryType: (c.salaryType as SalaryType) ?? 'ordinario',
      diasTrabajados: c.diasTrabajados,
      arlRiskLevel: c.arlRiskLevel as ArlLevel | undefined,
      fechaCorte,
    };
    const con = computeSlip({ ...base, novedades: { horas: clasif.horas } }, s);
    const sin = computeSlip(base, s);
    const debido = con.devengados.recargos + con.devengados.horasExtra;
    const pagado =
      (c.breakdown?.devengados?.recargos ?? 0) + (c.breakdown?.devengados?.horasExtra ?? 0);
    const diferencia = debido - pagado;
    if (diferencia <= 0) continue;
    out.push({
      corridaId: run.id,
      period: run.period,
      status: run.status,
      employeeId: c.employeeId,
      employeeName: c.employeeName,
      horas,
      pagado,
      debido,
      diferencia,
      ibcAdicional: con.ibc - sin.ibc,
    });
  }
  return out;
}

/** Conteo de la empresa para el resumen de `enCadaEmpresa`. */
export function contarNoPagado(filas: NoPagado[]): Conteo {
  return {
    corridas: new Set(filas.map((f) => f.corridaId)).size,
    cerradas: new Set(filas.filter((f) => f.status === 'cerrada').map((f) => f.corridaId)).size,
    empleados: new Set(filas.map((f) => f.employeeId)).size,
    colillas: filas.length,
    diferenciaCop: sumBy(filas, (f) => f.diferencia),
    ibcAdicionalCop: sumBy(filas, (f) => f.ibcAdicional),
  };
}

/** `--aplicar` no reliquida: no hay escritura segura que hacer por script. */
export function aplicarReliquidacion(): Promise<never> {
  return Promise.reject(
    new Error(
      'Solo informe: reliquidar recargos y extras de una nómina ya liquidada exige PILA de ' +
        'corrección del período y nota de ajuste de la nómina electrónica; no se hace por script.',
    ),
  );
}
