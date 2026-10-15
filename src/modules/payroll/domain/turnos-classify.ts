/**
 * Clasifica las horas registradas en Turnos (entrada/salida por día) en las
 * categorías de recargo/hora extra de la nómina colombiana. Las corridas reales
 * las liquidan tal cual; el simulador las muestra para revisar.
 *
 * Reglas:
 * - Jornada ordinaria con dos topes a la vez (arts. 159 y 161 CST): 8 h al día
 *   y la jornada semanal vigente (Ley 2101 de 2021 o la pactada, si es menor).
 *   Lo que exceda cualquiera de los dos es hora extra, y son las últimas horas
 *   del turno (art. 159 CST): si caen de noche, extra nocturna. La semana es la
 *   calendario, de lunes a domingo.
 * - Franja nocturna hasta las 6 a.m.; empieza a las 7 p.m. desde el 25-dic-2025
 *   (art. 160 CST, mod. Ley 2466 de 2025, art. 10) y antes a las 9 p.m.
 * - Domingos y festivos → recargo dominical, solo para las horas que caen en
 *   ese día: un turno que cruza la medianoche se parte.
 */
import { jornadaSemanalVigente, NovedadHoras } from './payroll-calc';
import { isSundayOrHoliday } from './colombia-holidays';
import { redondearA } from '../../finance/domain/money.util';
import {
  FRANJA_NOCTURNA_LEY_2466,
  NOCTURNO_DESDE_HORA_ANTERIOR,
  NOCTURNO_HASTA_HORA,
} from './payroll.constants';

const JORNADA_DIARIA_MIN = 8 * 60;
const NOCTURNO_HASTA_MIN = NOCTURNO_HASTA_HORA * 60;

/** Minuto del día en que empieza la franja nocturna en `fecha`. */
function nocturnoDesdeMin(fecha: string): number {
  let hora = NOCTURNO_DESDE_HORA_ANTERIOR;
  for (const t of FRANJA_NOCTURNA_LEY_2466) if (t.desde <= fecha) hora = t.desdeHora;
  return hora * 60;
}

/** Lunes (YYYY-MM-DD) de la semana calendario de `fecha`. */
export function lunesDe(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  const desdeLunes = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - desdeLunes);
  return date.toISOString().slice(0, 10);
}

export interface ClasificarOpciones {
  /**
   * Primer día (YYYY-MM-DD) que se liquida. Los registros anteriores (los de la
   * semana que empezó en el período previo) solo suman al tope semanal; no se
   * cuentan ni se pagan aquí.
   */
  desde?: string;
  /** Jornada semanal (h) vigente en una fecha. Por defecto, la legal. */
  jornadaSemanal?: (fecha: string) => number;
}

export interface TurnoRecord {
  workDate: string;
  checkIn?: string;
  checkOut?: string;
}

export interface NovedadesTurnos {
  diasTrabajados: number;
  totalHoras: number;
  horas: Required<NovedadHoras>;
}

function toMin(hhmm?: string): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (h == null || m == null) return null;
  return h * 60 + m;
}

/** ¿El minuto `m` de la línea extendida (0-2880) cae en la franja nocturna? */
function esNocturno(m: number, desdeMin: number): boolean {
  const delDia = m % 1440;
  return delDia < NOCTURNO_HASTA_MIN || delDia >= desdeMin;
}

/** Día siguiente (YYYY-MM-DD). */
function diaSiguiente(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1));
  return date.toISOString().slice(0, 10);
}

export function classifyTurnos(
  records: TurnoRecord[],
  opts: ClasificarOpciones = {},
): NovedadesTurnos {
  const jornadaSemanal =
    opts.jornadaSemanal ?? ((fecha: string) => jornadaSemanalVigente(fecha, {}));
  const acc = {
    recargoNocturno: 0,
    dominical: 0,
    nocturnoDominical: 0,
    extraDiurna: 0,
    extraNocturna: 0,
    extraDiurnaDominical: 0,
    extraNocturnaDominical: 0,
  };
  // Días distintos con marcación: una persona puede marcar en dos sedes el
  // mismo día (el índice es sede + empleado + fecha) y eso es UN día trabajado.
  const dias = new Set<string>();
  let totalMin = 0;
  // Minutos ordinarios ya consumidos de la jornada de cada semana (por lunes) y
  // de cada día: el tope de 8 h es del día, no de cada registro.
  const ordinarioSemana = new Map<string, number>();
  const ordinarioDia = new Map<string, number>();

  // En orden cronológico: el tope semanal lo agotan los primeros días y el
  // diario los primeros turnos del día; las extras quedan al final.
  const ordenados = [...records].sort((a, b) =>
    a.workDate === b.workDate
      ? (a.checkIn ?? '').localeCompare(b.checkIn ?? '')
      : a.workDate.localeCompare(b.workDate),
  );

  for (const r of ordenados) {
    const start = toMin(r.checkIn);
    let endRaw = toMin(r.checkOut);
    if (start == null || endRaw == null) continue;
    if (endRaw <= start) endRaw += 1440; // cruza medianoche
    const end = endRaw;
    const total = end - start;
    if (total <= 0) continue;

    const semana = lunesDe(r.workDate);
    const usado = ordinarioSemana.get(semana) ?? 0;
    const libreSemana = Math.max(0, jornadaSemanal(r.workDate) * 60 - usado);
    const usadoDia = ordinarioDia.get(r.workDate) ?? 0;
    const libreDia = Math.max(0, JORNADA_DIARIA_MIN - usadoDia);
    const ordinary = Math.min(total, libreDia, libreSemana);
    ordinarioSemana.set(semana, usado + ordinary);
    ordinarioDia.set(r.workDate, usadoDia + ordinary);
    if (opts.desde && r.workDate < opts.desde) continue;

    dias.add(r.workDate);
    totalMin += total;

    // El turno se parte en tramos homogéneos: cambian de clase en el inicio y
    // el fin de la franja nocturna, en la medianoche (el recargo dominical solo
    // grava las horas que caen en el día de descanso) y donde se acaba la
    // jornada ordinaria. Las extras son las ÚLTIMAS horas del turno (art. 159
    // CST): lo que se trabaja después de cumplida la jornada, no una
    // proporción de todo el turno.
    const desdeMin = nocturnoDesdeMin(r.workDate);
    const finOrdinario = start + ordinary;
    const cortes = [
      start,
      end,
      finOrdinario,
      NOCTURNO_HASTA_MIN,
      desdeMin,
      1440,
      1440 + NOCTURNO_HASTA_MIN,
      1440 + desdeMin,
    ]
      .filter((m) => m >= start && m <= end)
      .sort((a, b) => a - b);
    const descansoHoy = isSundayOrHoliday(r.workDate);
    const descansoManana = isSundayOrHoliday(diaSiguiente(r.workDate));

    for (let i = 0; i + 1 < cortes.length; i++) {
      const a = cortes[i]!;
      const b = cortes[i + 1]!;
      const min = b - a;
      if (min <= 0) continue;
      const noche = esNocturno(a, desdeMin);
      const extra = a >= finOrdinario;
      const descanso = a < 1440 ? descansoHoy : descansoManana;
      if (descanso) {
        if (extra) {
          if (noche) acc.extraNocturnaDominical += min;
          else acc.extraDiurnaDominical += min;
        } else if (noche) acc.nocturnoDominical += min;
        else acc.dominical += min;
      } else if (extra) {
        if (noche) acc.extraNocturna += min;
        else acc.extraDiurna += min;
      } else if (noche) acc.recargoNocturno += min;
      // Ordinaria diurna en día hábil: ya está en el salario.
    }
  }

  const h = (min: number) => redondearA(min / 60, 2);
  return {
    diasTrabajados: dias.size,
    totalHoras: h(totalMin),
    horas: {
      recargoNocturno: h(acc.recargoNocturno),
      dominical: h(acc.dominical),
      nocturnoDominical: h(acc.nocturnoDominical),
      extraDiurna: h(acc.extraDiurna),
      extraNocturna: h(acc.extraNocturna),
      extraDiurnaDominical: h(acc.extraDiurnaDominical),
      extraNocturnaDominical: h(acc.extraNocturnaDominical),
    },
  };
}
