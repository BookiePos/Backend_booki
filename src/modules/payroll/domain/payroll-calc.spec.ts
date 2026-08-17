import { describe, it, expect } from 'vitest';
import { computeSlip, PayrollInput } from './payroll-calc';
import {
  DEFAULT_PAYROLL_SETTINGS,
  DIAS_MES,
  PayrollSettingsData,
} from './payroll.constants';

const S: PayrollSettingsData = DEFAULT_PAYROLL_SETTINGS;
const round = (n: number) => Math.round(n);

/** Helper para armar un input con defaults razonables. */
function input(overrides: Partial<PayrollInput> = {}): PayrollInput {
  return {
    salarioBase: S.smmlv,
    salaryType: 'ordinario',
    diasTrabajados: DIAS_MES,
    ...overrides,
  };
}

describe('computeSlip - salario mínimo mes completo', () => {
  const slip = computeSlip(input(), S);

  it('devengado = salario base + auxilio de transporte', () => {
    expect(slip.devengados.salario).toBe(S.smmlv);
    expect(slip.devengados.auxilioTransporte).toBe(S.auxilioTransporte);
    expect(slip.devengados.total).toBe(S.smmlv + S.auxilioTransporte);
  });

  it('IBC = salario base (piso 1 SMMLV, sin auxilio) y dentro del tope', () => {
    expect(slip.ibc).toBe(S.smmlv);
    expect(slip.ibc).toBeGreaterThanOrEqual(S.ibcMinSmmlv * S.smmlv);
    expect(slip.ibc).toBeLessThanOrEqual(S.ibcMaxSmmlv * S.smmlv);
  });

  it('salud y pensión del empleado = 4% del IBC cada una', () => {
    expect(slip.deducciones.salud).toBe(round(S.smmlv * 0.04));
    expect(slip.deducciones.pension).toBe(round(S.smmlv * 0.04));
  });

  it('sin FSP ni retención para el salario mínimo', () => {
    expect(slip.deducciones.fsp).toBe(0);
    expect(slip.deducciones.retencionFuente).toBe(0);
  });

  it('neto = devengado - deducciones (invariante)', () => {
    expect(slip.netoPagar).toBe(
      slip.devengados.total - slip.deducciones.total,
    );
  });
});

describe('computeSlip - FSP por tramos (salarios altos)', () => {
  it('sin FSP cuando el IBC < 4 SMMLV', () => {
    const slip = computeSlip(input({ salarioBase: 3 * S.smmlv }), S);
    expect(slip.deducciones.fsp).toBe(0);
  });

  it('FSP del 1% cuando 4 <= IBC/SMMLV <= 16', () => {
    const salario = 5 * S.smmlv;
    const slip = computeSlip(input({ salarioBase: salario }), S);
    // ibc = 5 SMMLV → tramo hastaSmmlv 16 → 1%
    expect(slip.deducciones.fsp).toBe(round(slip.ibc * 0.01));
  });

  it('FSP del 2% en el tramo sin tope (IBC/SMMLV > 20)', () => {
    const salario = 21 * S.smmlv;
    const slip = computeSlip(input({ salarioBase: salario }), S);
    expect(slip.deducciones.fsp).toBe(round(slip.ibc * 0.02));
  });
});

describe('computeSlip - retención en la fuente (art. 383)', () => {
  it('retención = 0 para el salario mínimo', () => {
    const slip = computeSlip(input(), S);
    expect(slip.deducciones.retencionFuente).toBe(0);
  });

  it('retención > 0 para un salario alto', () => {
    const slip = computeSlip(input({ salarioBase: 12 * S.smmlv }), S);
    expect(slip.deducciones.retencionFuente).toBeGreaterThan(0);
  });

  it('a mayor salario, mayor retención (monotonía)', () => {
    const bajo = computeSlip(input({ salarioBase: 8 * S.smmlv }), S);
    const alto = computeSlip(input({ salarioBase: 15 * S.smmlv }), S);
    expect(alto.deducciones.retencionFuente).toBeGreaterThan(
      bajo.deducciones.retencionFuente,
    );
  });
});

describe('computeSlip - provisiones prestacionales', () => {
  it('cesantías, prima y sus intereses proporcionales a la base', () => {
    const slip = computeSlip(input(), S);
    const base = S.smmlv + S.auxilioTransporte; // devengoSalarial + auxTransporte
    expect(slip.provisiones.cesantias).toBe(round(base * S.cesantias));
    expect(slip.provisiones.prima).toBe(round(base * S.prima));
    expect(slip.provisiones.interesesCesantias).toBe(
      round(slip.provisiones.cesantias * S.interesesCesantias),
    );
  });

  it('vacaciones se calculan sobre el devengo salarial (sin auxilio)', () => {
    const slip = computeSlip(input(), S);
    expect(slip.provisiones.vacaciones).toBe(round(S.smmlv * S.vacaciones));
  });

  it('total de provisiones = suma de sus componentes', () => {
    const p = computeSlip(input(), S).provisiones;
    expect(p.total).toBe(
      p.cesantias + p.interesesCesantias + p.prima + p.vacaciones,
    );
  });
});

describe('computeSlip - proporcionalidad por días parciales', () => {
  const completo = computeSlip(input({ diasTrabajados: 30 }), S);
  const medio = computeSlip(input({ diasTrabajados: 15 }), S);

  it('salario a 15 días = mitad del mes completo', () => {
    expect(medio.devengados.salario).toBe(round(S.smmlv * (15 / 30)));
    expect(medio.devengados.salario).toBe(round(completo.devengados.salario / 2));
  });

  it('auxilio de transporte proporcional a los días', () => {
    expect(medio.devengados.auxilioTransporte).toBe(
      round(S.auxilioTransporte * (15 / 30)),
    );
  });

  it('días trabajados se topan al mes (30) y no bajan de 0', () => {
    expect(computeSlip(input({ diasTrabajados: 45 }), S).diasTrabajados).toBe(30);
    expect(computeSlip(input({ diasTrabajados: -5 }), S).diasTrabajados).toBe(0);
  });
});

describe('computeSlip - auxilio de transporte según el tope', () => {
  it('presente cuando el salario base <= 2 SMMLV', () => {
    const enTope = computeSlip(input({ salarioBase: 2 * S.smmlv }), S);
    expect(enTope.devengados.auxilioTransporte).toBe(S.auxilioTransporte);
  });

  it('ausente cuando el salario base supera 2 SMMLV', () => {
    const sobreTope = computeSlip(
      input({ salarioBase: 2 * S.smmlv + 1 }),
      S,
    );
    expect(sobreTope.devengados.auxilioTransporte).toBe(0);
  });

  it('ausente para salario integral', () => {
    const integral = computeSlip(
      input({ salarioBase: S.smmlv, salaryType: 'integral' }),
      S,
    );
    expect(integral.devengados.auxilioTransporte).toBe(0);
  });
});
