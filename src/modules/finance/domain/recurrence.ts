import { FREQUENCY_MONTHS, RecurrenceFrequency } from './finance.constants';

/** Convierte una Date local a 'YYYY-MM-DD'. */
function toStr(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

export interface RecurrenceSpec {
  frequency: RecurrenceFrequency;
  /** Día del mes (1–28) para mensual/trimestral/anual. */
  dayOfMonth: number;
  /** Ancla de las ocurrencias YYYY-MM-DD. */
  startDate: string;
  /** Fin de vigencia YYYY-MM-DD (opcional). */
  endDate?: string | null;
}

/**
 * Fechas-ocurrencia (YYYY-MM-DD) de una plantilla desde `startDate` hasta
 * `today` inclusive (acotado por `endDate`). Si se pasa `afterDate`, solo
 * devuelve ocurrencias posteriores (para no re-generar lo ya generado).
 *
 * - weekly  → ancla al día de `startDate`, paso de 7 días.
 * - monthly/quarterly/yearly → día `dayOfMonth` de cada N-ésimo mes.
 */
export function occurrencesUpTo(
  spec: RecurrenceSpec,
  today: string,
  afterDate?: string | null,
): string[] {
  const end = spec.endDate && spec.endDate < today ? spec.endDate : today;
  if (spec.startDate > end) return [];
  const floor = afterDate ?? '';
  const out: string[] = [];

  if (spec.frequency === 'weekly') {
    const base = new Date(`${spec.startDate}T00:00:00`);
    for (let i = 0; ; i++) {
      const s = toStr(new Date(base.getTime() + i * 7 * 86400 * 1000));
      if (s > end) break;
      if (s >= spec.startDate && s > floor) out.push(s);
    }
    return out;
  }

  const step = FREQUENCY_MONTHS[spec.frequency];
  const base = new Date(`${spec.startDate}T00:00:00`);
  const y0 = base.getFullYear();
  const m0 = base.getMonth();
  for (let i = 0; ; i++) {
    // `new Date` normaliza meses fuera de rango (m0 + k puede pasar de 11).
    const s = toStr(new Date(y0, m0 + i * step, spec.dayOfMonth));
    if (s > end) break;
    if (s >= spec.startDate && s > floor) out.push(s);
  }
  return out;
}
