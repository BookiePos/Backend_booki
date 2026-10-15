import { describe, it, expect } from 'vitest';

import { classifyTurnos, lunesDe } from './turnos-classify';

/**
 * Ítem 1.18: lo que Turnos clasifica es lo que la nómina real paga.
 *
 * - Franja nocturna (art. 160 CST, mod. Ley 2466 de 2025, art. 10): de 7 p.m.
 *   a 6 a.m. desde el 25-dic-2025 (seis meses después de la sanción, 25-jun-2025,
 *   parágrafo 2). Antes, de 9 p.m. a 6 a.m. (texto de la Ley 1846 de 2017).
 * - Horas extra (arts. 159 y 161 CST): lo que excede la jornada ordinaria, que
 *   tiene dos topes a la vez: 8 h al día y la jornada semanal vigente (42 h
 *   desde el 15-jul-2026, o la pactada si es menor).
 *
 * Fechas: 2025-12-24 es miércoles y 2025-12-26 viernes (el 25 es festivo);
 * 2026-09-07 es lunes y 2026-09-12 sábado.
 */
describe('classifyTurnos · franja nocturna por fecha', () => {
  it('antes del 25-dic-2025 la noche empieza a las 9 p.m.', () => {
    const r = classifyTurnos([
      { workDate: '2025-12-24', checkIn: '14:00', checkOut: '22:00' },
    ]);
    expect(r.horas.recargoNocturno).toBe(1);
  });

  it('desde el 25-dic-2025 empieza a las 7 p.m.', () => {
    const r = classifyTurnos([
      { workDate: '2025-12-26', checkIn: '14:00', checkOut: '22:00' },
    ]);
    expect(r.horas.recargoNocturno).toBe(3);
  });
});

describe('classifyTurnos · horas extra contra la jornada semanal', () => {
  const SEMANA = ['07', '08', '09', '10', '11', '12'].map((d) => ({
    workDate: `2026-09-${d}`,
    checkIn: '08:00',
    checkOut: '16:00',
  }));

  it('seis días de 8 h (48 h) con jornada de 42 h dejan 6 h extra', () => {
    const r = classifyTurnos(SEMANA);
    expect(r.totalHoras).toBe(48);
    expect(r.horas.extraDiurna).toBe(6);
  });

  it('con una jornada semanal de 48 h no hay extras', () => {
    const r = classifyTurnos(SEMANA, { jornadaSemanal: () => 48 });
    expect(r.horas.extraDiurna).toBe(0);
  });

  it('los días previos al período cuentan para la semana, pero no se pagan dos veces', () => {
    const r = classifyTurnos(SEMANA, { desde: '2026-09-10' });
    expect(r.diasTrabajados).toBe(3);
    expect(r.totalHoras).toBe(24);
    expect(r.horas.extraDiurna).toBe(6);
  });

  it('el tope diario de 8 h sigue rigiendo aunque la semana no se llene', () => {
    const r = classifyTurnos([
      { workDate: '2026-09-07', checkIn: '08:00', checkOut: '18:00' },
    ]);
    expect(r.horas.extraDiurna).toBe(2);
  });

  it('lunesDe da el lunes de la semana calendario', () => {
    expect(lunesDe('2026-09-13')).toBe('2026-09-07');
    expect(lunesDe('2026-09-07')).toBe('2026-09-07');
    expect(lunesDe('2026-10-01')).toBe('2026-09-28');
  });
});

describe('classifyTurnos · turno partido a medianoche', () => {
  // 2026-09-12 sábado, 2026-09-13 domingo, 2026-09-14 lunes.
  it('el sábado que entra al domingo: solo lo del domingo es dominical', () => {
    const r = classifyTurnos([
      { workDate: '2026-09-12', checkIn: '20:00', checkOut: '04:00' },
    ]);
    expect(r.horas.recargoNocturno).toBe(4);
    expect(r.horas.nocturnoDominical).toBe(4);
  });

  it('el domingo que entra al lunes: lo del lunes no es dominical', () => {
    const r = classifyTurnos([
      { workDate: '2026-09-13', checkIn: '20:00', checkOut: '04:00' },
    ]);
    expect(r.horas.nocturnoDominical).toBe(4);
    expect(r.horas.recargoNocturno).toBe(4);
  });

  it('las extras que caen en el domingo son extras dominicales', () => {
    // Sábado 16:00 a domingo 02:00: ordinarias 16-24 (5 nocturnas desde las
    // 19:00), extras 00-02 del domingo, nocturnas.
    const r = classifyTurnos([
      { workDate: '2026-09-12', checkIn: '16:00', checkOut: '02:00' },
    ]);
    expect(r.horas.recargoNocturno).toBe(5);
    expect(r.horas.extraNocturnaDominical).toBe(2);
    expect(r.horas.extraNocturna).toBe(0);
  });
});

describe('classifyTurnos · varios turnos el mismo día', () => {
  // El índice de asistencia es {sedeId, employeeId, workDate}: una persona
  // puede marcar en dos sedes el mismo día. El tope de 8 h es por día.
  const DOS_SEDES = [
    { workDate: '2026-09-07', checkIn: '15:00', checkOut: '20:00' },
    { workDate: '2026-09-07', checkIn: '08:00', checkOut: '13:00' },
  ];

  it('el tope diario de 8 h se aplica al día, no a cada registro', () => {
    const r = classifyTurnos(DOS_SEDES);
    // 08-13 y 15-18 ordinarias; 18-20 son las dos últimas horas: extras, la
    // de 19-20 ya nocturna.
    expect(r.totalHoras).toBe(10);
    expect(r.horas.extraDiurna).toBe(1);
    expect(r.horas.extraNocturna).toBe(1);
    expect(r.horas.recargoNocturno).toBe(0);
  });

  it('cuenta un día trabajado, no dos', () => {
    expect(classifyTurnos(DOS_SEDES).diasTrabajados).toBe(1);
  });
});


describe('tope de horas extra (Ley 2466 de 2025, art. 13)', () => {
  it('cuenta los días con más de 2 h extra y las semanas con más de 12', () => {
    // Lunes 7 a sábado 12 de septiembre de 2026, 11 h diarias: 3 h extra al día.
    const recs = ['07', '08', '09', '10', '11', '12'].map((d) => ({
      workDate: `2026-09-${d}`,
      checkIn: '07:00',
      checkOut: '18:00',
    }));
    const r = classifyTurnos(recs, { desde: '2026-09-01' });
    expect(r.topeExtras.diasSobre2h).toBe(6);
    expect(r.topeExtras.semanasSobre12h).toBe(1);
  });

  it('dentro del tope no avisa', () => {
    const r = classifyTurnos(
      [{ workDate: '2026-09-07', checkIn: '07:00', checkOut: '17:00' }],
      { desde: '2026-09-01' },
    );
    expect(r.topeExtras).toEqual({ diasSobre2h: 0, semanasSobre12h: 0 });
  });
});
