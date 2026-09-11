import { describe, it, expect } from 'vitest';

import { classifyTurnos } from './turnos-classify';

/**
 * Clasificación de las horas marcadas en Turnos hacia los recargos de nómina.
 *
 * De aquí sale cuánto se le paga de más a cada persona por trabajar de noche,
 * en domingo o pasada la jornada. Una franja mal medida no rompe nada: nadie se
 * entera hasta que alguien reclama, y para entonces ya se pagó mal varios meses.
 *
 * Reglas fijadas aquí: jornada de 8 horas, franja nocturna de 7 p.m. a 6 a.m.,
 * y domingo o festivo con su propio recargo.
 *
 * Fechas usadas: 2026-09-07 es lunes, 2026-09-13 es domingo y 2026-01-01 es
 * festivo (Año Nuevo).
 */
describe('classifyTurnos', () => {
  const LUNES = '2026-09-07';
  const DOMINGO = '2026-09-13';
  const FESTIVO = '2026-01-01';

  it('una jornada diurna entre semana no genera ningún recargo', () => {
    const r = classifyTurnos([
      { workDate: LUNES, checkIn: '08:00', checkOut: '16:00' },
    ]);

    expect(r.diasTrabajados).toBe(1);
    expect(r.totalHoras).toBe(8);
    expect(Object.values(r.horas).every((h) => h === 0)).toBe(true);
  });

  it('lo que cae después de las 7 p.m. cuenta como recargo nocturno', () => {
    // 2 p.m. a 10 p.m.: las tres últimas horas son nocturnas.
    const r = classifyTurnos([
      { workDate: LUNES, checkIn: '14:00', checkOut: '22:00' },
    ]);

    expect(r.horas.recargoNocturno).toBe(3);
    expect(r.horas.extraDiurna).toBe(0);
  });

  it('lo que cae antes de las 6 a.m. también es nocturno', () => {
    const r = classifyTurnos([
      { workDate: LUNES, checkIn: '04:00', checkOut: '12:00' },
    ]);

    expect(r.horas.recargoNocturno).toBe(2);
  });

  it('un turno que cruza la medianoche se mide entero, no se parte', () => {
    // 8 p.m. a 4 a.m.: ocho horas, todas dentro de la franja nocturna.
    const r = classifyTurnos([
      { workDate: LUNES, checkIn: '20:00', checkOut: '04:00' },
    ]);

    expect(r.totalHoras).toBe(8);
    expect(r.horas.recargoNocturno).toBe(8);
    expect(r.horas.extraNocturna).toBe(0);
  });

  it('lo que pasa de 8 horas es hora extra', () => {
    const r = classifyTurnos([
      { workDate: LUNES, checkIn: '08:00', checkOut: '18:00' },
    ]);

    expect(r.totalHoras).toBe(10);
    expect(r.horas.extraDiurna).toBe(2);
    expect(r.horas.recargoNocturno).toBe(0);
  });

  it('la parte nocturna de las extras va a extra nocturna', () => {
    // 2 p.m. a medianoche: 10 horas, de las cuales 5 son nocturnas (7 p.m. en
    // adelante). La proporción nocturna se aplica igual a ordinarias y extras.
    const r = classifyTurnos([
      { workDate: LUNES, checkIn: '14:00', checkOut: '00:00' },
    ]);

    expect(r.totalHoras).toBe(10);
    expect(r.horas.extraDiurna + r.horas.extraNocturna).toBe(2);
    expect(r.horas.extraNocturna).toBe(1);
    expect(r.horas.recargoNocturno).toBe(4);
  });

  describe('domingos y festivos', () => {
    it('el domingo la jornada ordinaria SÍ genera recargo', () => {
      const r = classifyTurnos([
        { workDate: DOMINGO, checkIn: '08:00', checkOut: '16:00' },
      ]);

      expect(r.horas.dominical).toBe(8);
      expect(r.horas.recargoNocturno).toBe(0);
    });

    it('un festivo se trata igual que un domingo', () => {
      const r = classifyTurnos([
        { workDate: FESTIVO, checkIn: '08:00', checkOut: '16:00' },
      ]);

      expect(r.horas.dominical).toBe(8);
    });

    it('la noche del domingo tiene su propia categoría', () => {
      const r = classifyTurnos([
        { workDate: DOMINGO, checkIn: '14:00', checkOut: '22:00' },
      ]);

      expect(r.horas.nocturnoDominical).toBe(3);
      expect(r.horas.dominical).toBe(5);
      expect(r.horas.recargoNocturno).toBe(0);
    });

    it('las extras del domingo no se mezclan con las de entre semana', () => {
      const r = classifyTurnos([
        { workDate: DOMINGO, checkIn: '08:00', checkOut: '18:00' },
      ]);

      expect(r.horas.extraDiurnaDominical).toBe(2);
      expect(r.horas.extraDiurna).toBe(0);
      expect(r.horas.dominical).toBe(8);
    });
  });

  describe('registros incompletos', () => {
    it('un turno sin salida no se cuenta como día trabajado', () => {
      const r = classifyTurnos([
        { workDate: LUNES, checkIn: '08:00' },
        { workDate: DOMINGO, checkIn: '08:00', checkOut: '16:00' },
      ]);

      expect(r.diasTrabajados).toBe(1);
      expect(r.totalHoras).toBe(8);
    });

    it('sin marcaciones no suma nada y no revienta', () => {
      const r = classifyTurnos([]);

      expect(r.diasTrabajados).toBe(0);
      expect(r.totalHoras).toBe(0);
    });
  });

  it('acumula varios días y devuelve horas con dos decimales', () => {
    const r = classifyTurnos([
      { workDate: LUNES, checkIn: '08:00', checkOut: '16:30' },
      { workDate: '2026-09-08', checkIn: '08:00', checkOut: '16:20' },
    ]);

    expect(r.diasTrabajados).toBe(2);
    expect(r.totalHoras).toBe(16.83);
    // Media hora y veinte minutos por encima de la jornada.
    expect(r.horas.extraDiurna).toBe(0.83);
  });
});
