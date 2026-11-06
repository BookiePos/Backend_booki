/**
 * Novedades de ausencia del mes (decisión 3 del dueño, tarea 11): vacaciones
 * disfrutadas, incapacidades y licencias. Función pura: recibe las novedades
 * registradas del empleado y devuelve, para el periodo, los días de cada una
 * (mes comercial de 30) y su valor en COP entero.
 *
 * Reglas (a confirmar con el contador donde se indica):
 * - Vacaciones disfrutadas: salario de los días (art. 186 CST); cotizan a
 *   salud y pensión (Decreto 1406/1999 art. 40). Con salario variable, el art.
 *   192 CST manda el promedio del último año: aquí se usa el fijo.
 * - Incapacidad común: 2/3 del salario los primeros 90 días y 1/2 del 91 al
 *   180 (art. 227 CST), nunca menos del SMMLV diario. Los 2 primeros días los
 *   paga el empleador y desde el 3 la EPS (Decreto 2943/2013); desde el 181,
 *   el fondo de pensiones (Ley 962/2005 art. 142).
 * - Incapacidad laboral o profesional: 100 % del salario desde el día 1, a
 *   cargo de la ARL (Ley 776/2002 art. 3).
 * - Licencias de maternidad y paternidad: 100 % del salario, a cargo de la EPS
 *   (art. 236 CST, Ley 1822/2017; Ley 2114/2021).
 * - Licencia remunerada (luto, calamidad, sufragio…): 100 %, empleador.
 * - Licencia no remunerada: no paga; suspende el contrato (art. 51 CST) y
 *   solo genera el aporte a pensión del empleador sobre el salario de esos días
 *   (Decreto 1406/1999 art. 71: A CONFIRMAR con el contador si el trabajador
 *   también aporta su 4 %).
 */
import { cop, redondearA, sumCop } from '../../finance/domain/money.util';
import { dias360Inclusivo } from './liquidacion-calc';

export const TIPOS_NOVEDAD = [
  'vacaciones',
  'incapacidad_comun',
  'incapacidad_profesional',
  'incapacidad_laboral',
  'licencia_maternidad',
  'licencia_paternidad',
  'licencia_remunerada',
  'licencia_no_remunerada',
] as const;
export type TipoNovedad = (typeof TIPOS_NOVEDAD)[number];

export type PagadorNovedad = 'empleador' | 'eps' | 'arl' | 'fondo_pensiones' | 'ninguno';

export interface NovedadAusencia {
  id?: string;
  tipo: TipoNovedad;
  /** YYYY-MM-DD, ambos incluidos. */
  fechaInicio: string;
  fechaFin: string;
  /** Incapacidad común que prorroga otra: días ya incapacitado antes de esta (para el 66,67 % / 50 % y quién paga). */
  diasPreviosProrroga?: number;
  /** Vacaciones: días hábiles disfrutados (los que descuenta la liquidación de retiro). */
  diasHabiles?: number;
}

export interface AusenciaLinea {
  id?: string;
  tipo: TipoNovedad;
  /** Tramo dentro del periodo. */
  fechaInicio: string;
  fechaFin: string;
  /** Días comerciales (mes de 30) dentro del periodo. */
  dias: number;
  /** COP entero que paga la nómina por esos días (0 en la no remunerada). */
  valor: number;
  pagador: PagadorNovedad;
  /** Quién reconoce cada día en la incapacidad común (el empleador adelanta y recobra a la EPS). */
  diasPorPagador?: Partial<Record<PagadorNovedad, number>>;
}

export interface AusenciasLiquidadas {
  lineas: AusenciaLinea[];
  /** Días con pago (todo menos la licencia no remunerada). */
  diasRemunerados: number;
  diasNoRemunerados: number;
  /** Suma de `valor`: entra al devengado y al IBC. */
  totalRemunerado: number;
  /** Salario de los días de licencia no remunerada: base del aporte a pensión del empleador. */
  basePensionNoRemunerada: number;
}

const ultimoDia = (periodo: string): string => {
  const y = Number(periodo.slice(0, 4));
  const m = Number(periodo.slice(5, 7));
  return `${periodo}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** Tramo de [desde, hasta] dentro del mes, o null si no lo toca. */
export function tramoEnPeriodo(desde: string, hasta: string, periodo: string): { desde: string; hasta: string } | null {
  const ini = `${periodo}-01`;
  const fin = ultimoDia(periodo);
  const d = desde > ini ? desde : ini;
  const h = hasta < fin ? hasta : fin;
  return d <= h ? { desde: d, hasta: h } : null;
}

const PAGADOR_FIJO: Record<Exclude<TipoNovedad, 'incapacidad_comun'>, PagadorNovedad> = {
  vacaciones: 'empleador',
  incapacidad_profesional: 'arl',
  incapacidad_laboral: 'arl',
  licencia_maternidad: 'eps',
  licencia_paternidad: 'eps',
  licencia_remunerada: 'empleador',
  licencia_no_remunerada: 'ninguno',
};

/** Fracción del salario que paga el día `k` (1 = primero) de una incapacidad común (art. 227 CST). */
const fraccionComun = (k: number): number => (k <= 90 ? 2 / 3 : 1 / 2);
const pagadorComun = (k: number): PagadorNovedad => (k <= 2 ? 'empleador' : k <= 180 ? 'eps' : 'fondo_pensiones');

/**
 * Liquida las novedades del `periodo` (YYYY-MM). Las que no tocan el mes se
 * ignoran; las que lo cruzan se recortan a él. Los días se cuentan en mes
 * comercial (30), como el resto de la colilla.
 */
export function liquidarAusencias(
  novedades: NovedadAusencia[],
  periodo: string,
  salarioBase: number,
  smmlv: number,
): AusenciasLiquidadas {
  const diario = salarioBase / 30;
  const minimoDiario = smmlv / 30;
  const lineas: AusenciaLinea[] = [];
  for (const n of [...novedades].sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio))) {
    const t = tramoEnPeriodo(n.fechaInicio, n.fechaFin, periodo);
    if (!t) continue;
    const dias = dias360Inclusivo(t.desde, t.hasta);
    if (dias <= 0) continue;
    if (n.tipo === 'incapacidad_comun') {
      // Días ya corridos de la misma incapacidad: los anteriores al mes y las prórrogas.
      const antes = Math.max(0, n.diasPreviosProrroga ?? 0) + (t.desde > n.fechaInicio ? dias360Inclusivo(n.fechaInicio, t.desde) - 1 : 0);
      let valor = 0;
      const porPagador: Partial<Record<PagadorNovedad, number>> = {};
      for (let i = 1; i <= dias; i++) {
        const k = antes + i;
        valor += Math.max(diario * fraccionComun(k), minimoDiario);
        const p = pagadorComun(k);
        porPagador[p] = (porPagador[p] ?? 0) + 1;
      }
      const pagador: PagadorNovedad = porPagador.fondo_pensiones ? 'fondo_pensiones' : porPagador.eps ? 'eps' : 'empleador';
      lineas.push({ id: n.id, tipo: n.tipo, fechaInicio: t.desde, fechaFin: t.hasta, dias, valor: cop(valor), pagador, diasPorPagador: porPagador });
      continue;
    }
    const remunerada = n.tipo !== 'licencia_no_remunerada';
    lineas.push({
      id: n.id,
      tipo: n.tipo,
      fechaInicio: t.desde,
      fechaFin: t.hasta,
      dias,
      valor: remunerada ? cop(diario * dias) : 0,
      pagador: PAGADOR_FIJO[n.tipo],
    });
  }
  const remuneradas = lineas.filter((l) => l.tipo !== 'licencia_no_remunerada');
  const noRem = lineas.filter((l) => l.tipo === 'licencia_no_remunerada');
  const diasNoRemunerados = noRem.reduce((s, l) => s + l.dias, 0);
  return {
    lineas,
    diasRemunerados: remuneradas.reduce((s, l) => s + l.dias, 0),
    diasNoRemunerados,
    totalRemunerado: sumCop(remuneradas.map((l) => l.valor)),
    basePensionNoRemunerada: diasNoRemunerados > 0 ? cop(Math.max(diario, minimoDiario) * diasNoRemunerados) : 0,
  };
}

/** Días hábiles de vacaciones disfrutados en todas las novedades (sugerencia para la liquidación de retiro). */
export function vacacionesDisfrutadasDeNovedades(novedades: NovedadAusencia[]): number {
  return redondearA(
    novedades.filter((n) => n.tipo === 'vacaciones').reduce((s, n) => s + Math.max(0, n.diasHabiles ?? 0), 0),
    2,
  );
}
