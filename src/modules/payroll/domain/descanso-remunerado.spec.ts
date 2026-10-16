import { describe, it, expect } from 'vitest';
import { diasALiquidar, diasDescansoRemunerado } from './descanso-remunerado';
import { holidaysOfYear } from './colombia-holidays';

/**
 * Ítem 1.19: el descanso obligatorio es remunerado (CST arts. 172, 173 y 177).
 * La nómina pagaba solo los días con turno, así que quien trabaja de lunes a
 * sábado cobraba unos 26 de 30 días.
 */
const fechas = (...ds: string[]) => new Set(ds);
/** Lunes a sábado de una semana que empieza en `lunes` (YYYY-MM-DD). */
function semanaCompleta(lunes: string, dias = 6): string[] {
  const [y, m, d] = lunes.split('-').map(Number);
  return Array.from({ length: dias }, (_, i) =>
    new Date(Date.UTC(y!, m! - 1, d! + i)).toISOString().slice(0, 10),
  );
}

describe('descanso dominical y festivos remunerados', () => {
  // Septiembre de 2026: lunes 7 a sábado 12, domingo 13.
  it('paga el domingo de una semana trabajada completa (art. 173)', () => {
    const t = fechas(...semanaCompleta('2026-09-07'));
    expect(diasDescansoRemunerado(t, '2026-09-07', '2026-09-13', 6)).toBe(1);
  });

  it('no paga el domingo si faltó un día laborable', () => {
    const t = fechas(...semanaCompleta('2026-09-07').slice(0, 5));
    expect(diasDescansoRemunerado(t, '2026-09-07', '2026-09-13', 6)).toBe(0);
  });

  it('con semana de 5 días paga el sábado y el domingo (art. 164)', () => {
    const t = fechas(...semanaCompleta('2026-09-07', 5));
    expect(diasDescansoRemunerado(t, '2026-09-07', '2026-09-13', 5)).toBe(2);
  });

  it('con semana de 5 días, si faltó un día no paga ni sábado ni domingo', () => {
    const t = fechas(...semanaCompleta('2026-09-07', 5).slice(0, 4));
    expect(diasDescansoRemunerado(t, '2026-09-07', '2026-09-13', 5)).toBe(0);
  });

  it('con semana de 6 días el sábado es laborable: solo se paga el domingo', () => {
    const t = fechas(...semanaCompleta('2026-09-07', 6));
    expect(diasDescansoRemunerado(t, '2026-09-07', '2026-09-13', 6)).toBe(1);
  });

  it('un domingo trabajado no es descanso: ya se cuenta como día trabajado', () => {
    const t = fechas(...semanaCompleta('2026-09-07'), '2026-09-13');
    expect(diasDescansoRemunerado(t, '2026-09-07', '2026-09-13', 6)).toBe(0);
  });

  it('el festivo entre semana no laborado se paga y no exige ese día (art. 177)', () => {
    // 2026-08-17 es lunes festivo (Asunción trasladada): semana 17-22 de agosto.
    const t = fechas('2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22');
    // Festivo del lunes + domingo 23 (la semana laborable quedó completa).
    expect(diasDescansoRemunerado(t, '2026-08-17', '2026-08-23', 6)).toBe(2);
  });

  it('la semana que empezó en el mes anterior cuenta para el domingo del período', () => {
    // Semana lun 28-sep a sáb 3-oct; el domingo 4 de octubre es del período.
    const t = fechas(...semanaCompleta('2026-09-28'));
    expect(diasDescansoRemunerado(t, '2026-10-01', '2026-10-31', 6)).toBe(1);
  });

  it('sin turnos no paga descansos', () => {
    expect(diasDescansoRemunerado(new Set(), '2026-09-01', '2026-09-30', 6)).toBe(0);
  });
});

/** Días hábiles (sin festivos ni domingos, ni sábado con semana de 5) entre dos fechas. */
function habiles(desde: string, hasta: string, diasSemana: number, salvo: string[] = []): Set<string> {
  const out = new Set<string>();
  const [y, m, d] = desde.split('-').map(Number);
  for (let i = 0; ; i++) {
    const f = new Date(Date.UTC(y!, m! - 1, d! + i));
    const iso = f.toISOString().slice(0, 10);
    if (iso > hasta) break;
    const dow = (f.getUTCDay() + 6) % 7;
    if (dow >= diasSemana || holidaysOfYear(f.getUTCFullYear()).has(iso)) continue;
    if (!salvo.includes(iso)) out.add(iso);
  }
  return out;
}

describe('días a liquidar sobre el mes comercial de 30 días', () => {
  // Se lee desde el lunes de la semana del día 1, como hace la nómina.
  it('semana de 5 días: lunes a viernes todo el mes cobra 30 días', () => {
    // Septiembre de 2026: el 1 es martes; la semana arranca el lunes 31-ago.
    const t = habiles('2026-08-31', '2026-09-30', 5);
    expect(diasALiquidar(t, '2026-09-01', '2026-09-30', 5)).toBe(30);
  });

  it('semana de 6 días: lunes a sábado todo el mes cobra 30 días', () => {
    const t = habiles('2026-08-31', '2026-09-30', 6);
    expect(diasALiquidar(t, '2026-09-01', '2026-09-30', 6)).toBe(30);
  });

  it('febrero trabajado completo cobra 30 días, no 28', () => {
    // 2026-02-01 es domingo: se paga por la semana del 26 al 31 de enero.
    const t = habiles('2026-01-26', '2026-02-28', 6);
    expect(diasALiquidar(t, '2026-02-01', '2026-02-28', 6)).toBe(30);
    const t5 = habiles('2026-01-26', '2026-02-28', 5);
    expect(diasALiquidar(t5, '2026-02-01', '2026-02-28', 5)).toBe(30);
  });

  it('febrero con una ausencia descuenta sobre la base de 30', () => {
    // Falta el miércoles 11: pierde ese día y el domingo 15 (art. 173).
    const t = habiles('2026-01-26', '2026-02-28', 6, ['2026-02-11']);
    expect(diasALiquidar(t, '2026-02-01', '2026-02-28', 6)).toBe(28);
  });

  it('febrero con retiro el 10 no cobra los días hasta el 30', () => {
    const t = habiles('2026-01-26', '2026-02-10', 6);
    expect(diasALiquidar(t, '2026-02-01', '2026-02-28', 6)).toBe(10);
  });

  it('febrero sin turnos no cobra nada', () => {
    expect(diasALiquidar(new Set(), '2026-02-01', '2026-02-28', 6)).toBe(0);
  });

  it('un mes de 31 días trabajado completo cobra 30 (el 31 no se paga ni se descuenta)', () => {
    // Octubre de 2026: el 12 es festivo (lunes); el 1 es jueves.
    const t = habiles('2026-09-28', '2026-10-31', 6);
    expect(diasALiquidar(t, '2026-10-01', '2026-10-31', 6)).toBe(30);
    const t5 = habiles('2026-09-28', '2026-10-31', 5);
    expect(diasALiquidar(t5, '2026-10-01', '2026-10-31', 5)).toBe(30);
  });

  it('quincenas de 15 días que suman el mes, también en febrero', () => {
    const oct = habiles('2026-09-28', '2026-10-31', 6);
    expect(diasALiquidar(oct, '2026-10-01', '2026-10-15', 6)).toBe(15);
    expect(diasALiquidar(oct, '2026-10-16', '2026-10-31', 6)).toBe(15);
    const feb = habiles('2026-01-26', '2026-02-28', 5);
    expect(diasALiquidar(feb, '2026-02-01', '2026-02-15', 5)).toBe(15);
    expect(diasALiquidar(feb, '2026-02-16', '2026-02-28', 5)).toBe(15);
  });

  it('una quincena con una ausencia cobra 13 (el día y el domingo)', () => {
    const t = habiles('2026-09-28', '2026-10-31', 6, ['2026-10-07']);
    expect(diasALiquidar(t, '2026-10-01', '2026-10-15', 6)).toBe(13);
  });
});
