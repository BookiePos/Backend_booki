import { describe, expect, it } from 'vitest';
import { DEFAULT_PAYROLL_SETTINGS } from './payroll.constants';
import { calcularPrimeraQuincena, diasPrimeraQuincena } from './quincena-calc';

const s = { ...DEFAULT_PAYROLL_SETTINGS, exoneracionConfirmada: true };

describe('primera quincena · días', () => {
  it('paga los 15 días a quien trabajó toda la quincena', () => {
    expect(diasPrimeraQuincena('2026-11', {}, [])).toEqual({ dias: 15, ausentes: 0 });
  });

  it('descuenta los días antes del ingreso', () => {
    expect(diasPrimeraQuincena('2026-11', { hireDate: '2026-11-06' }, []).dias).toBe(10);
  });

  it('descuenta vacaciones e incapacidades sin contar dos veces el mismo día', () => {
    const r = diasPrimeraQuincena('2026-11', {}, [
      { fechaInicio: '2026-10-28', fechaFin: '2026-11-03' },
      { fechaInicio: '2026-11-03', fechaFin: '2026-11-04' },
      { fechaInicio: '2026-11-14', fechaFin: '2026-11-20' },
    ]);
    // 1, 2, 3, 4, 14 y 15 fuera: quedan 9.
    expect(r.dias).toBe(9);
  });

  it('no paga quincena a quien se retira el 15 o antes, ni a quien entra después', () => {
    expect(diasPrimeraQuincena('2026-11', { terminationDate: '2026-11-15' }, []).dias).toBe(0);
    expect(diasPrimeraQuincena('2026-11', { hireDate: '2026-11-16' }, []).dias).toBe(0);
  });
});

describe('primera quincena · valores', () => {
  it('con el salario mínimo: medio sueldo y medio auxilio, menos salud y pensión de esos días', () => {
    const c = calcularPrimeraQuincena({ salario: 1_750_905, salaryType: 'ordinario' }, 15, s, '2026-11-15');
    expect(c.sueldo).toBe(875_453);
    expect(c.auxilioTransporte).toBe(124_548);
    expect(c.salud).toBe(35_018);
    expect(c.pension).toBe(35_018);
    // 929.965 por partes, pero la mitad del neto del mes (1.859.928) es 929.964:
    // el peso del redondeo queda para la segunda quincena.
    expect(c.tope).toBe(929_964);
    expect(c.neto).toBe(929_964);
  });

  it('nunca pasa de la mitad del neto estimado del mes (con retención, la segunda quincena la cubre)', () => {
    const c = calcularPrimeraQuincena({ salario: 12_000_000, salaryType: 'ordinario' }, 15, s, '2026-11-15');
    expect(c.retencionEstimadaMes).toBeGreaterThan(0);
    expect(c.neto).toBe(c.tope);
  });
});

describe('primera quincena · horas extra y recargos', () => {
  it('paga las horas extra y los recargos del 1 al 15, con su salud y pensión', () => {
    const sin = calcularPrimeraQuincena({ salario: 1_750_905, salaryType: 'ordinario' }, 15, s, '2026-11-15');
    const con = calcularPrimeraQuincena({ salario: 1_750_905, salaryType: 'ordinario' }, 15, s, '2026-11-15', {
      recargoNocturno: 4,
      extraDiurna: 2,
    });
    expect(con.recargos).toBeGreaterThan(0);
    expect(con.horasExtra).toBeGreaterThan(0);
    // Son salario: suben salud y pensión.
    expect(con.salud).toBeGreaterThan(sin.salud);
    expect(con.neto).toBeGreaterThan(sin.neto);
    expect(con.neto).toBeLessThanOrEqual(con.tope);
  });

  it('al salario integral no le paga recargos ni extras (art. 132 CST)', () => {
    const c = calcularPrimeraQuincena({ salario: 30_000_000, salaryType: 'integral' }, 15, s, '2026-11-15', {
      extraDiurna: 5,
    });
    expect(c.recargos).toBe(0);
    expect(c.horasExtra).toBe(0);
  });
});
