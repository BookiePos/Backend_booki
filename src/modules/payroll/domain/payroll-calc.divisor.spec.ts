import { describe, it, expect } from 'vitest';
import {
  computeSlip,
  fechaCorteDePeriodo,
  horasMesVigentes,
} from './payroll-calc';
import {
  DEFAULT_PAYROLL_SETTINGS,
  DIAS_MES,
  PayrollSettingsData,
} from './payroll.constants';

/**
 * Ítem 1.8: el valor hora se divide por las horas mensuales de la jornada
 * máxima legal vigente en la fecha del período (Ley 2101/2021, art. 3; CST
 * art. 161), no por 240 fijo. Divisor = horas semanales / 6 × 30 (Concepto
 * MinTrabajo 08SI2023120300000016177 de 2023): 47→235, 46→230, 44→220, 42→210.
 */
const S: PayrollSettingsData = DEFAULT_PAYROLL_SETTINGS;
const SALARIO = 2_100_000;

describe('horasMesVigentes - tramos de la Ley 2101', () => {
  it.each([
    ['2023-07-14', 240],
    ['2023-07-15', 235],
    ['2024-07-14', 235],
    ['2024-07-15', 230],
    ['2025-07-14', 230],
    ['2025-07-15', 220],
    ['2026-07-14', 220],
    ['2026-07-15', 210],
    ['2027-12-31', 210],
  ])('el %s el divisor mensual es %i h', (fecha, horas) => {
    expect(horasMesVigentes(fecha, S)).toBe(horas);
  });

  it('un expediente viejo sin tabla de jornada cae a la tabla legal', () => {
    const viejo = { ...S, jornadaTramos: undefined };
    expect(horasMesVigentes('2026-08-31', viejo)).toBe(210);
  });

  it('respeta el ajuste de la empresa (jornada pactada menor)', () => {
    const empresa = {
      ...S,
      jornadaTramos: [...(S.jornadaTramos ?? []), { desde: '2026-09-01', horasSemana: 40 }],
    };
    expect(horasMesVigentes('2026-08-31', empresa)).toBe(210);
    expect(horasMesVigentes('2026-09-30', empresa)).toBe(200);
  });
});

describe('fechaCorteDePeriodo', () => {
  it('es el último día del mes liquidado', () => {
    expect(fechaCorteDePeriodo('2026-07')).toBe('2026-07-31');
    expect(fechaCorteDePeriodo('2028-02')).toBe('2028-02-29');
  });
});

describe('computeSlip - valor hora con el divisor vigente', () => {
  const base = {
    salarioBase: SALARIO,
    salaryType: 'ordinario' as const,
    diasTrabajados: DIAS_MES,
    novedades: { horas: { extraDiurna: 10, recargoNocturno: 4 } },
  };

  it('agosto de 2026 (42 h) divide por 210, no por 240', () => {
    const slip = computeSlip({ ...base, fechaCorte: '2026-08-31' }, S);
    expect(slip.divisorHoras).toBe(210);
    expect(slip.horaOrdinaria).toBe(SALARIO / 210);
    // 10 h extra diurna = 10 × 10.000 × 1,25; 4 h nocturno = 4 × 10.000 × 0,35.
    expect(slip.devengados.horasExtra).toBe(125_000);
    expect(slip.devengados.recargos).toBe(14_000);
  });

  it('marzo de 2026 (44 h) divide por 220', () => {
    const slip = computeSlip({ ...base, fechaCorte: '2026-03-31' }, S);
    expect(slip.divisorHoras).toBe(220);
    expect(slip.devengados.horasExtra).toBe(Math.round((10 * SALARIO * 1.25) / 220));
  });
});
