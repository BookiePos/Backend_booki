/**
 * Clasifica las horas registradas en Turnos (entrada/salida por día) en las
 * categorías de recargo/hora extra de la nómina colombiana. Es una SUGERENCIA
 * para revisar: el operador confirma o ajusta antes de liquidar.
 *
 * Reglas usadas: jornada ordinaria 8h/día; franja nocturna 7pm–6am (Ley
 * 2466/2025); domingos y festivos → recargo dominical. Lo que exceda 8h/día
 * son horas extra; su porción nocturna va a la extra nocturna.
 */
import { NovedadHoras } from './payroll-calc';
import { isSundayOrHoliday } from './colombia-holidays';

const JORNADA_DIARIA_MIN = 8 * 60;
const NOCTURNO_DESDE_MIN = 19 * 60; // 7:00 p.m.
const NOCTURNO_HASTA_MIN = 6 * 60; // 6:00 a.m.

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

function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function nightMinutes(start: number, end: number): number {
  // Franjas nocturnas en la línea de tiempo extendida (cruza medianoche).
  return (
    overlap(start, end, 0, NOCTURNO_HASTA_MIN) +
    overlap(start, end, NOCTURNO_DESDE_MIN, 1440) +
    overlap(start, end, 1440, 1440 + NOCTURNO_HASTA_MIN)
  );
}

export function classifyTurnos(records: TurnoRecord[]): NovedadesTurnos {
  const acc = {
    recargoNocturno: 0,
    dominical: 0,
    nocturnoDominical: 0,
    extraDiurna: 0,
    extraNocturna: 0,
    extraDiurnaDominical: 0,
    extraNocturnaDominical: 0,
  };
  let diasTrabajados = 0;
  let totalMin = 0;

  for (const r of records) {
    const start = toMin(r.checkIn);
    let endRaw = toMin(r.checkOut);
    if (start == null || endRaw == null) continue;
    if (endRaw <= start) endRaw += 1440; // cruza medianoche
    const end = endRaw;
    const total = end - start;
    if (total <= 0) continue;
    diasTrabajados++;
    totalMin += total;

    const night = nightMinutes(start, end);
    const ordinary = Math.min(total, JORNADA_DIARIA_MIN);
    const extra = Math.max(0, total - JORNADA_DIARIA_MIN);
    const nightFrac = night / total;
    const ordNight = ordinary * nightFrac;
    const ordDay = ordinary - ordNight;
    const exNight = extra * nightFrac;
    const exDay = extra - exNight;

    if (isSundayOrHoliday(r.workDate)) {
      acc.dominical += ordDay;
      acc.nocturnoDominical += ordNight;
      acc.extraDiurnaDominical += exDay;
      acc.extraNocturnaDominical += exNight;
    } else {
      acc.recargoNocturno += ordNight;
      acc.extraDiurna += exDay;
      acc.extraNocturna += exNight;
      // ordDay ordinario de día en semana = ya está en el salario.
    }
  }

  const h = (min: number) => Math.round((min / 60) * 100) / 100;
  return {
    diasTrabajados,
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
