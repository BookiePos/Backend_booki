/**
 * Novedades de ausencia del mes (decisión 3 del dueño, tarea 11): vacaciones
 * disfrutadas, incapacidades y licencias. Función pura: recibe las novedades
 * registradas del empleado y devuelve, para el periodo, los días de cada una
 * y su valor en COP entero.
 *
 * Días: se cuentan días CALENDARIO dentro del tramo del mes. Un febrero entero
 * de ausencia se completa hasta 30 y el total del mes se topa en 30 (mes
 * comercial): así un mes entero de ausencia siempre da 30.
 * Las prórrogas y los umbrales de 2, 90 y 180 días van en días calendario.
 *
 * Reglas (a confirmar con el contador donde se indica):
 * - Vacaciones disfrutadas: salario de los días (art. 186 CST); cotizan a
 *   salud y pensión (Decreto 1406/1999 art. 40). Con salario variable, el art.
 *   192 CST manda el promedio del último año: se usa `salarioPromedio` si viene.
 * - Incapacidad común: 2/3 del salario los primeros 90 días y 1/2 del 91 al
 *   180 (art. 227 CST), nunca menos del SMMLV diario. Los 2 primeros días los
 *   paga el empleador y desde el 3 la EPS (Decreto 2943/2013); desde el 181,
 *   el fondo de pensiones (Decreto-ley 019/2012 art. 142, que modificó el art.
 *   41 de la Ley 100/1993).
 * - Incapacidad laboral o profesional: 100 % del salario desde el día 1, a
 *   cargo de la ARL (Ley 776/2002 art. 3).
 * - Licencias de maternidad y paternidad: 100 % del salario, a cargo de la EPS
 *   (art. 236 CST, Ley 1822/2017; Ley 2114/2021).
 * - Licencia remunerada (luto, calamidad, sufragio…): 100 %, empleador.
 * - Con salario integral, incapacidades y licencias de maternidad/paternidad
 *   se liquidan sobre el IBC (70 %, art. 132 CST). Vacaciones y licencia
 *   remunerada son salario del empleador y van al 100 %.
 *
 * Límites conocidos:
 * - Dos novedades parciales que juntas cubren un febrero entero no se
 *   completan a 30 (solo un tramo que cubre el mes entero): los 2 días que
 *   faltan quedan como días básicos aunque no haya turnos.
 * - Licencia no remunerada: no paga; suspende el contrato (art. 51 CST). Se
 *   cotiza pensión: 16 % sobre el último salario (piso 1 SMMLV), 12 % del
 *   empleador y 4 % del trabajador, que se le descuenta en la colilla
 *   (Decreto 1406/1999 art. 71): A CONFIRMAR con el contador.
 */
import { cop, redondearA, sumCop } from '../../finance/domain/money.util';

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
  /** Incapacidad común que prorroga otra: días calendario ya incapacitado antes de esta. */
  diasPreviosProrroga?: number;
  /** Vacaciones: días hábiles disfrutados (los que descuenta la liquidación de retiro). */
  diasHabiles?: number;
  /** Vacaciones con salario variable: promedio del último año (art. 192 CST). */
  salarioPromedio?: number;
}

export interface AusenciaLinea {
  id?: string;
  tipo: TipoNovedad;
  /** Tramo dentro del periodo. */
  fechaInicio: string;
  fechaFin: string;
  /** Días del tramo (calendario, con febrero completado a 30 y el mes topado en 30). */
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
  /**
   * Parte de `totalRemunerado` liquidada al 100 % del salario (vacaciones y
   * licencia remunerada). En el integral es la única a la que el IBC le aplica
   * el factor; incapacidades y maternidad/paternidad ya vienen sobre el IBC.
   */
  pagoAlSalario: number;
  /** Base del aporte a pensión de la licencia no remunerada (último salario de esos días, piso SMMLV). */
  basePensionNoRemunerada: number;
}

export interface OpcionesAusencias {
  /** Salario integral: incapacidades y licencias sobre este factor del salario (IBC, art. 132 CST). */
  factorIntegral?: number;
}

const DIA_MS = 86_400_000;
/** Novedades que se pagan al 100 % del salario también en el integral. */
const AL_SALARIO = new Set<TipoNovedad>(['vacaciones', 'licencia_remunerada']);
const DIAS_MES = 30;

const ultimoDia = (periodo: string): string => {
  const y = Number(periodo.slice(0, 4));
  const m = Number(periodo.slice(5, 7));
  return `${periodo}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** Días calendario entre dos fechas, ambas incluidas. */
export function diasCalendario(desde: string, hasta: string): number {
  if (hasta < desde) return 0;
  return redondearA((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS, 0) + 1;
}

/** Tramo de [desde, hasta] dentro del mes, o null si no lo toca. */
export function tramoEnPeriodo(desde: string, hasta: string, periodo: string): { desde: string; hasta: string } | null {
  const ini = `${periodo}-01`;
  const fin = ultimoDia(periodo);
  const d = desde > ini ? desde : ini;
  const h = hasta < fin ? hasta : fin;
  return d <= h ? { desde: d, hasta: h } : null;
}

/**
 * Días que paga un tramo del mes: los calendario. Solo si cubre el mes ENTERO
 * de un febrero se completa hasta 30 (un mes entero de ausencia siempre da
 * 30); un tramo parcial cuenta sus días reales y el resto del mes comercial
 * queda para los días trabajados.
 */
export function diasDelTramo(t: { desde: string; hasta: string }, periodo: string): number {
  const fin = ultimoDia(periodo);
  const largoMes = Number(fin.slice(8, 10));
  const mesEntero = t.desde === `${periodo}-01` && t.hasta === fin;
  const relleno = mesEntero && largoMes < DIAS_MES ? DIAS_MES - largoMes : 0;
  return diasCalendario(t.desde, t.hasta) + relleno;
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

/** Fracción del salario que paga el día `k` (1 = primero, calendario) de una incapacidad común (art. 227 CST). */
const fraccionComun = (k: number): number => (k <= 90 ? 2 / 3 : 1 / 2);
const pagadorComun = (k: number): PagadorNovedad => (k <= 2 ? 'empleador' : k <= 180 ? 'eps' : 'fondo_pensiones');

/**
 * Liquida las novedades del `periodo` (YYYY-MM). Las que no tocan el mes se
 * ignoran; las que lo cruzan se recortan a él.
 */
export function liquidarAusencias(
  novedades: NovedadAusencia[],
  periodo: string,
  salarioBase: number,
  smmlv: number,
  opciones: OpcionesAusencias = {},
): AusenciasLiquidadas {
  const factor = opciones.factorIntegral ?? 1;
  // Incapacidades y licencias: sobre el IBC (en integral, el 70 %). Vacaciones: sobre el salario.
  const diarioIbc = (salarioBase * factor) / DIAS_MES;
  const minimoDiario = smmlv / DIAS_MES;
  const lineas: AusenciaLinea[] = [];
  let disponibles = DIAS_MES;
  for (const n of [...novedades].sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio))) {
    const t = tramoEnPeriodo(n.fechaInicio, n.fechaFin, periodo);
    if (!t) continue;
    const calendario = diasCalendario(t.desde, t.hasta);
    // Tope del mes en 30: si un mes de 31 días queda todo en ausencias, el último día no suma.
    const dias = Math.min(diasDelTramo(t, periodo), disponibles);
    if (dias <= 0) continue;
    disponibles -= dias;
    // Días que el tramo paga de más (febrero) o de menos (tope del mes) respecto al calendario.
    const ajuste = dias - calendario;

    if (n.tipo === 'incapacidad_comun') {
      // Días calendario ya corridos de la misma incapacidad: las prórrogas y lo anterior al mes.
      const antes = Math.max(0, n.diasPreviosProrroga ?? 0) + (t.desde > n.fechaInicio ? diasCalendario(n.fechaInicio, t.desde) - 1 : 0);
      const valorDia = (k: number) => Math.max(diarioIbc * fraccionComun(k), minimoDiario);
      let valor = 0;
      const porPagador: Partial<Record<PagadorNovedad, number>> = {};
      for (let i = 1; i <= calendario; i++) {
        const k = antes + i;
        valor += valorDia(k);
        const p = pagadorComun(k);
        porPagador[p] = (porPagador[p] ?? 0) + 1;
      }
      // El relleno de febrero o el tope del mes se valoran como el último día del tramo.
      const ultimoK = antes + calendario;
      valor += ajuste * valorDia(ultimoK);
      const pUlt = pagadorComun(ultimoK);
      porPagador[pUlt] = (porPagador[pUlt] ?? 0) + ajuste;
      const pagador: PagadorNovedad = porPagador.fondo_pensiones ? 'fondo_pensiones' : porPagador.eps ? 'eps' : 'empleador';
      lineas.push({ id: n.id, tipo: n.tipo, fechaInicio: t.desde, fechaFin: t.hasta, dias, valor: cop(valor), pagador, diasPorPagador: porPagador });
      continue;
    }
    // Vacaciones y licencia remunerada son salario que paga el empleador: van al 100 % aunque el salario
    // sea integral. Incapacidades y maternidad/paternidad, sobre el IBC (70 % en integral).
    const diario =
      n.tipo === 'vacaciones'
        ? (n.salarioPromedio && n.salarioPromedio > 0 ? n.salarioPromedio : salarioBase) / DIAS_MES
        : n.tipo === 'licencia_remunerada'
          ? salarioBase / DIAS_MES
          : diarioIbc;
    lineas.push({
      id: n.id,
      tipo: n.tipo,
      fechaInicio: t.desde,
      fechaFin: t.hasta,
      dias,
      valor: n.tipo === 'licencia_no_remunerada' ? 0 : cop(diario * dias),
      pagador: PAGADOR_FIJO[n.tipo],
    });
  }
  const remuneradas = lineas.filter((l) => l.tipo !== 'licencia_no_remunerada');
  const diasNoRemunerados = lineas.filter((l) => l.tipo === 'licencia_no_remunerada').reduce((s, l) => s + l.dias, 0);
  return {
    lineas,
    diasRemunerados: remuneradas.reduce((s, l) => s + l.dias, 0),
    diasNoRemunerados,
    totalRemunerado: sumCop(remuneradas.map((l) => l.valor)),
    pagoAlSalario: sumCop(remuneradas.filter((l) => AL_SALARIO.has(l.tipo)).map((l) => l.valor)),
    basePensionNoRemunerada: diasNoRemunerados > 0 ? cop(Math.max(diarioIbc, minimoDiario) * diasNoRemunerados) : 0,
  };
}

/** Días hábiles de vacaciones disfrutados en todas las novedades (sugerencia para la liquidación de retiro). */
export function vacacionesDisfrutadasDeNovedades(novedades: NovedadAusencia[]): number {
  return redondearA(
    novedades.filter((n) => n.tipo === 'vacaciones').reduce((s, n) => s + Math.max(0, n.diasHabiles ?? 0), 0),
    2,
  );
}
