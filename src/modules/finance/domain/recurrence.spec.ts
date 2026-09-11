import { describe, it, expect } from 'vitest';

import { occurrencesUpTo } from './recurrence';

/**
 * Calendario de los gastos recurrentes (arriendo, servicios, nómina de terceros).
 *
 * Lo que se protege aquí es el doble cobro. El barrido corre cada pocas horas y
 * vuelve a preguntar por las mismas plantillas; si devolviera ocurrencias ya
 * generadas, cada arriendo entraría dos o tres veces al mes y el estado de
 * resultados quedaría inflado sin que nadie sepa por qué. El corte lo hace
 * `afterDate`, que es la última fecha generada.
 *
 * Al otro lado está el error contrario: saltarse una ocurrencia y que el gasto
 * nunca se registre.
 */
describe('occurrencesUpTo', () => {
  const mensual = {
    frequency: 'monthly' as const,
    dayOfMonth: 15,
    startDate: '2026-01-15',
  };

  it('devuelve una ocurrencia por mes hasta hoy, inclusive', () => {
    expect(occurrencesUpTo(mensual, '2026-04-20')).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ]);
  });

  it('el día exacto de la ocurrencia ya cuenta', () => {
    expect(occurrencesUpTo(mensual, '2026-02-15')).toEqual([
      '2026-01-15',
      '2026-02-15',
    ]);
  });

  it('no repite lo ya generado: ahí está la defensa contra el doble cobro', () => {
    expect(occurrencesUpTo(mensual, '2026-04-20', '2026-02-15')).toEqual([
      '2026-03-15',
      '2026-04-15',
    ]);
  });

  it('si ya se generó todo, un nuevo barrido no devuelve nada', () => {
    expect(occurrencesUpTo(mensual, '2026-04-20', '2026-04-15')).toEqual([]);
  });

  it('recupera meses atrasados de una sola vez', () => {
    // El servidor estuvo caído tres meses: al volver, se generan los tres.
    expect(occurrencesUpTo(mensual, '2026-04-20', '2026-01-15')).toEqual([
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ]);
  });

  it('una plantilla que arranca en el futuro todavía no genera nada', () => {
    expect(
      occurrencesUpTo({ ...mensual, startDate: '2026-12-15' }, '2026-04-20'),
    ).toEqual([]);
  });

  it('deja de generar después de la fecha de fin', () => {
    expect(
      occurrencesUpTo({ ...mensual, endDate: '2026-02-28' }, '2026-06-20'),
    ).toEqual(['2026-01-15', '2026-02-15']);
  });

  it('el día 28 funciona en febrero, que es la razón del tope', () => {
    // El DTO limita `dayOfMonth` a 28 justamente para que ningún mes se salte:
    // con 31, febrero se desbordaría al 3 de marzo.
    expect(
      occurrencesUpTo(
        { ...mensual, dayOfMonth: 28, startDate: '2026-01-28' },
        '2026-03-01',
      ),
    ).toEqual(['2026-01-28', '2026-02-28']);
  });

  describe('otras frecuencias', () => {
    it('semanal avanza de siete en siete desde el arranque', () => {
      expect(
        occurrencesUpTo(
          { frequency: 'weekly', dayOfMonth: 1, startDate: '2026-01-05' },
          '2026-02-02',
        ),
      ).toEqual([
        '2026-01-05',
        '2026-01-12',
        '2026-01-19',
        '2026-01-26',
        '2026-02-02',
      ]);
    });

    it('semanal también respeta lo ya generado', () => {
      expect(
        occurrencesUpTo(
          { frequency: 'weekly', dayOfMonth: 1, startDate: '2026-01-05' },
          '2026-02-02',
          '2026-01-19',
        ),
      ).toEqual(['2026-01-26', '2026-02-02']);
    });

    it('trimestral salta tres meses', () => {
      expect(
        occurrencesUpTo({ ...mensual, frequency: 'quarterly' }, '2026-10-20'),
      ).toEqual(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
    });

    it('anual genera una sola vez al año', () => {
      expect(
        occurrencesUpTo({ ...mensual, frequency: 'yearly' }, '2027-06-20'),
      ).toEqual(['2026-01-15', '2027-01-15']);
    });
  });
});
