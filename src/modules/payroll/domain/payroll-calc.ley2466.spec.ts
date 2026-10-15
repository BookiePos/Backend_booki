import { describe, it, expect } from 'vitest';
import {
  computeSlip,
  horasMesVigentes,
  jornadaSemanalVigente,
  recargosVigentes,
} from './payroll-calc';
import {
  DEFAULT_PAYROLL_SETTINGS,
  DIAS_MES,
  JORNADA_TRAMOS_LEY_2101,
  PayrollSettingsData,
} from './payroll.constants';

/**
 * Ítems 1.8 (remate) y 1.18.
 *
 * Jornada: la tabla legal (Ley 2101 de 2021, art. 3) es el techo y la tabla de
 * la empresa solo guarda PACTOS. El pacto vigente se combina con el tramo legal
 * vigente en la fecha (el menor), así que un pacto de 40 h firmado en 2024 no
 * se pierde cuando en 2026 entra el tramo legal de 42 h.
 *
 * Recargo dominical y festivo (art. 179 CST, mod. Ley 2466 de 2025, art. 14,
 * parágrafo transitorio): 75 % antes del 1-jul-2025, 80 % desde esa fecha,
 * 90 % desde el 1-jul-2026 y 100 % desde el 1-jul-2027.
 */
const S: PayrollSettingsData = DEFAULT_PAYROLL_SETTINGS;
const SALARIO = 2_100_000;

describe('jornada pactada frente a la legal', () => {
  it('la tabla de la empresa nace vacía: solo guarda pactos', () => {
    expect(DEFAULT_PAYROLL_SETTINGS.jornadaTramos).toEqual([]);
  });

  it('un pacto anterior a un tramo legal sigue rigiendo (40 h de 2024 en 2026)', () => {
    const empresa = { ...S, jornadaTramos: [{ desde: '2024-01-01', horasSemana: 40 }] };
    expect(jornadaSemanalVigente('2026-10-31', empresa)).toBe(40);
    expect(horasMesVigentes('2026-10-31', empresa)).toBe(200);
  });

  it('un expediente que copió la tabla legal no pisa el pacto con el tramo más reciente', () => {
    const guardado = {
      ...S,
      jornadaTramos: [...JORNADA_TRAMOS_LEY_2101, { desde: '2024-01-01', horasSemana: 40 }],
    };
    expect(horasMesVigentes('2026-10-31', guardado)).toBe(200);
  });

  it('un pacto por encima de la legal no sube la jornada', () => {
    const empresa = { ...S, jornadaTramos: [{ desde: '2024-01-01', horasSemana: 46 }] };
    expect(jornadaSemanalVigente('2026-10-31', empresa)).toBe(42);
  });

  it('antes de que empiece el pacto rige la legal', () => {
    const empresa = { ...S, jornadaTramos: [{ desde: '2026-09-01', horasSemana: 40 }] };
    expect(jornadaSemanalVigente('2026-08-31', empresa)).toBe(42);
  });
});

describe('recargo dominical y festivo por fecha (Ley 2466 de 2025, art. 14)', () => {
  it.each([
    ['2025-06-30', 0.75],
    ['2025-07-01', 0.8],
    ['2026-06-30', 0.8],
    ['2026-07-01', 0.9],
    ['2027-06-30', 0.9],
    ['2027-07-01', 1],
  ])('el %s el recargo dominical es %s', (fecha, factor) => {
    expect(recargosVigentes(fecha, S).dominical).toBe(factor);
  });

  it('los recargos combinados suman el dominical vigente', () => {
    const r = recargosVigentes('2026-03-31', S);
    expect(r.nocturnoDominical).toBeCloseTo(0.35 + 0.8, 10);
    expect(r.extraDiurnaDominical).toBeCloseTo(0.25 + 0.8, 10);
    expect(r.extraNocturnaDominical).toBeCloseTo(0.75 + 0.8, 10);
  });

  it('un pacto por encima del legal se respeta; por debajo, rige el legal', () => {
    expect(recargosVigentes('2026-03-31', { ...S, recargoDominicalPactado: 1 }).dominical).toBe(1);
    expect(recargosVigentes('2026-08-31', { ...S, recargoDominicalPactado: 0.8 }).dominical).toBe(0.9);
  });

  it('el valor guardado en el expediente (copia de 2026) no adelanta el 90 %', () => {
    const viejo = { ...S, recargos: { ...S.recargos, dominical: 0.9 } };
    expect(recargosVigentes('2026-03-31', viejo).dominical).toBe(0.8);
  });

  it('nocturno y extras no bajan del mínimo legal (art. 168 CST)', () => {
    const bajo = {
      ...S,
      recargos: { ...S.recargos, recargoNocturno: 0.2, extraDiurna: 0.1, extraNocturna: 0.5 },
    };
    const r = recargosVigentes('2026-03-31', bajo);
    expect([r.recargoNocturno, r.extraDiurna, r.extraNocturna]).toEqual([0.35, 0.25, 0.75]);
  });

  it('computeSlip liquida el domingo con el recargo de la fecha del período', () => {
    const base = {
      salarioBase: SALARIO,
      salaryType: 'ordinario' as const,
      diasTrabajados: DIAS_MES,
      novedades: { horas: { dominical: 8 } },
    };
    // Marzo 2026: 44 h → 220; 80 %.
    const marzo = computeSlip({ ...base, fechaCorte: '2026-03-31' }, S);
    expect(marzo.devengados.recargos).toBe(Math.round((8 * SALARIO * 0.8) / 220));
    // Agosto 2026: 42 h → 210; 90 %.
    const agosto = computeSlip({ ...base, fechaCorte: '2026-08-31' }, S);
    expect(agosto.devengados.recargos).toBe(Math.round((8 * SALARIO * 0.9) / 210));
  });
});

describe('salario integral (CST art. 132 num. 2)', () => {
  it('no paga recargos ni extras: el integral ya los compensa', () => {
    const slip = computeSlip(
      {
        salarioBase: 13 * S.smmlv,
        salaryType: 'integral',
        diasTrabajados: DIAS_MES,
        novedades: { horas: { dominical: 8, recargoNocturno: 4, extraDiurna: 2 } },
        fechaCorte: '2026-09-30',
      },
      S,
    );
    expect(slip.devengados.recargos).toBe(0);
    expect(slip.devengados.horasExtra).toBe(0);
    expect(slip.devengados.recargoDetalle).toEqual([]);
  });
});

describe('provisión de vacaciones (CST art. 192)', () => {
  it('excluye las horas extra y el trabajo en días de descanso', () => {
    const slip = computeSlip(
      {
        salarioBase: SALARIO,
        salaryType: 'ordinario',
        diasTrabajados: DIAS_MES,
        novedades: {
          horas: { recargoNocturno: 4, dominical: 8, nocturnoDominical: 2, extraDiurna: 10 },
        },
        fechaCorte: '2026-09-30',
      },
      S,
    );
    const nocturno = slip.devengados.recargoDetalle.find((l) => l.key === 'recargoNocturno')!;
    expect(slip.provisiones.vacaciones).toBe(
      Math.round((slip.devengados.salario + nocturno.valor) * S.vacaciones),
    );
  });
});

