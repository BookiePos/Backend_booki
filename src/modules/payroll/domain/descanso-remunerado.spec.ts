import { describe, it, expect } from 'vitest';
import { diasDescansoRemunerado } from './descanso-remunerado';

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

  it('con semana de 5 días basta trabajar de lunes a viernes', () => {
    const t = fechas(...semanaCompleta('2026-09-07', 5));
    expect(diasDescansoRemunerado(t, '2026-09-07', '2026-09-13', 5)).toBe(1);
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
