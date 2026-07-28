/**
 * Festivos de Colombia por año: fijos, los movibles a lunes (Ley Emiliani) y los
 * ligados a la Pascua (Semana Santa, Ascensión, Corpus Christi, Sagrado
 * Corazón). Se usa para clasificar horas dominicales/festivas de la nómina.
 */

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}

/** Mueve la fecha al lunes siguiente si no cae en lunes (Ley Emiliani). */
function toMonday(d: Date): Date {
  const dow = d.getUTCDay(); // 0=domingo … 6=sábado
  return addDays(d, (8 - dow) % 7);
}

/** Domingo de Pascua (algoritmo de Gauss / Gregoriano anónimo). */
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=marzo, 4=abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const cache = new Map<number, Set<string>>();

/** Conjunto de festivos "YYYY-MM-DD" del año. */
export function holidaysOfYear(year: number): Set<string> {
  const cached = cache.get(year);
  if (cached) return cached;

  const set = new Set<string>();
  const fixed: [number, number][] = [
    [1, 1],
    [5, 1],
    [7, 20],
    [8, 7],
    [12, 8],
    [12, 25],
  ];
  for (const [m, d] of fixed) set.add(ymd(new Date(Date.UTC(year, m - 1, d))));

  const emiliani: [number, number][] = [
    [1, 6],
    [3, 19],
    [6, 29],
    [8, 15],
    [10, 12],
    [11, 1],
    [11, 11],
  ];
  for (const [m, d] of emiliani) {
    set.add(ymd(toMonday(new Date(Date.UTC(year, m - 1, d)))));
  }

  const e = easter(year);
  set.add(ymd(addDays(e, -3))); // Jueves Santo
  set.add(ymd(addDays(e, -2))); // Viernes Santo
  set.add(ymd(toMonday(addDays(e, 39)))); // Ascensión
  set.add(ymd(toMonday(addDays(e, 60)))); // Corpus Christi
  set.add(ymd(toMonday(addDays(e, 68)))); // Sagrado Corazón

  cache.set(year, set);
  return set;
}

/** ¿La fecha "YYYY-MM-DD" es domingo o festivo en Colombia? */
export function isSundayOrHoliday(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  if (date.getUTCDay() === 0) return true;
  return holidaysOfYear(y ?? 1970).has(dateStr);
}
