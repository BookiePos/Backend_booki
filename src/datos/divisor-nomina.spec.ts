import { describe, it, expect } from 'vitest';
import { contarDivisor, diferenciaCorrida, type CorridaGuardada } from './divisor-nomina';
import { DEFAULT_PAYROLL_SETTINGS } from '../modules/payroll/domain/payroll.constants';

const S = DEFAULT_PAYROLL_SETTINGS;

function corrida(period: string, divisorHoras?: number, horasExtra = 0): CorridaGuardada {
  return {
    id: 'r1',
    period,
    status: 'cerrada',
    slips: [
      {
        salarioBase: 2_100_000,
        breakdown: {
          divisorHoras,
          devengados: {
            recargoDetalle: horasExtra
              ? [{ key: 'extraDiurna', label: 'Hora extra diurna', horas: horasExtra, factor: 0.25, valor: 0 }]
              : [],
          },
        },
      },
    ],
  };
}

describe('diferenciaCorrida', () => {
  it('una corrida vieja (sin divisor guardado) de agosto 2026 usó 240 y debía 210', () => {
    const d = diferenciaCorrida(corrida('2026-08', undefined, 10), S);
    expect(d).toMatchObject({ divisorUsado: 240, divisorCorrecto: 210, colillasConHoras: 1 });
    // 10 h × 1,25 × (2.100.000/210 − 2.100.000/240) = 125.000 − 109.375.
    expect(d?.diferencia).toBe(125_000 - 109_375);
  });

  it('sin horas la diferencia en pesos es 0, pero la corrida se lista', () => {
    const d = diferenciaCorrida(corrida('2026-03'), S);
    expect(d).toMatchObject({ divisorUsado: 240, divisorCorrecto: 220, diferencia: 0 });
  });

  it('no lista lo que ya se liquidó con el divisor correcto', () => {
    expect(diferenciaCorrida(corrida('2026-08', 210, 10), S)).toBeNull();
    expect(diferenciaCorrida(corrida('2023-06', undefined, 10), S)).toBeNull();
  });

  it('el conteo suma corridas, cerradas y pesos', () => {
    const d = diferenciaCorrida(corrida('2026-08', undefined, 10), S)!;
    expect(contarDivisor([d])).toEqual({
      corridasConOtroDivisor: 1,
      cerradas: 1,
      colillasConHoras: 1,
      diferenciaCop: 15_625,
    });
  });
});
