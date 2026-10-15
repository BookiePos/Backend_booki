import { describe, it, expect } from 'vitest';
import {
  aplicarReliquidacion,
  contarNoPagado,
  noPagadoCorrida,
  type CorridaLiquidada,
} from './recargos-no-pagados';
import { DEFAULT_PAYROLL_SETTINGS } from '../modules/payroll/domain/payroll.constants';

/**
 * Ítem 1.18: informe en seco de lo que las nóminas ya liquidadas dejaron de
 * pagar en recargos y extras. 2026-09-13 es domingo; septiembre de 2026 tiene
 * jornada de 42 h (divisor 210) y dominical del 90 %.
 */
const S = DEFAULT_PAYROLL_SETTINGS;
const SALARIO = 2_100_000;

function corrida(pagado = 0): CorridaLiquidada {
  return {
    id: 'r1',
    period: '2026-09',
    status: 'cerrada',
    slips: [
      {
        employeeId: 'e1',
        employeeName: 'Ana Ruiz',
        salarioBase: SALARIO,
        salaryType: 'ordinario',
        diasTrabajados: 1,
        breakdown: { devengados: { recargos: pagado, horasExtra: 0 } },
      },
      {
        employeeId: 'e2',
        salarioBase: SALARIO,
        diasTrabajados: 1,
        breakdown: { devengados: { recargos: 0, horasExtra: 0 } },
      },
    ],
  };
}

const TURNOS = [
  { employeeId: 'e1', workDate: '2026-09-13', checkIn: '08:00', checkOut: '16:00' },
  // e2 trabajó un lunes diurno: nada que reclamar.
  { employeeId: 'e2', workDate: '2026-09-14', checkIn: '08:00', checkOut: '16:00' },
];

describe('noPagadoCorrida', () => {
  it('reporta por empleado el dominical que la colilla no pagó', () => {
    const filas = noPagadoCorrida(corrida(), TURNOS, S);

    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      employeeId: 'e1',
      horas: 8,
      pagado: 0,
      debido: Math.round((8 * SALARIO * 0.9) / 210),
      diferencia: Math.round((8 * SALARIO * 0.9) / 210),
    });
    expect(filas[0]!.ibcAdicional).toBeGreaterThan(0);
  });

  it('una colilla que ya pagó lo debido no aparece', () => {
    const debido = Math.round((8 * SALARIO * 0.9) / 210);
    expect(noPagadoCorrida(corrida(debido), TURNOS, S)).toEqual([]);
  });

  it('el conteo resume corridas, empleados y pesos', () => {
    const c = contarNoPagado(noPagadoCorrida(corrida(), TURNOS, S));
    expect(c).toMatchObject({ corridas: 1, cerradas: 1, empleados: 1, colillas: 1 });
    expect(c.diferenciaCop).toBe(Math.round((8 * SALARIO * 0.9) / 210));
  });

  it('--aplicar falla: reliquidar exige PILA de corrección y nota de ajuste', async () => {
    await expect(aplicarReliquidacion()).rejects.toThrow(/PILA de corrección/);
  });
});
