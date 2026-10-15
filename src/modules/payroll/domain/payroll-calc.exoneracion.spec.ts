import { describe, it, expect } from 'vitest';
import { computeSlip } from './payroll-calc';
import {
  DEFAULT_PAYROLL_SETTINGS,
  DIAS_MES,
  PayrollSettingsData,
} from './payroll.constants';

/**
 * Ítem 1.15: la exoneración de aportes (art. 114-1 ET) no se presume. Solo
 * aplica a sociedades declarantes de renta y a personas naturales con dos o
 * más trabajadores; venía activada por defecto, así que una empresa que no
 * cumplía dejaba de pagar salud, SENA e ICBF del empleador sin saberlo.
 */
const S: PayrollSettingsData = DEFAULT_PAYROLL_SETTINGS;
const slip = (s: PayrollSettingsData) =>
  computeSlip(
    {
      salarioBase: 2 * S.smmlv,
      salaryType: 'ordinario',
      diasTrabajados: DIAS_MES,
      fechaCorte: '2026-09-30',
    },
    s,
  );

describe('exoneración de aportes (art. 114-1 ET)', () => {
  it('por defecto no se presume: el empleador paga salud, SENA e ICBF', () => {
    expect(S.empresaExoneradaAportes).toBe(false);
    const a = slip(S).aportesEmpleador;
    expect(a.salud).toBeGreaterThan(0);
    expect(a.sena).toBeGreaterThan(0);
    expect(a.icbf).toBeGreaterThan(0);
  });

  it('marcada pero nunca confirmada (expedientes anteriores): tampoco exonera', () => {
    const a = slip({ ...S, empresaExoneradaAportes: true }).aportesEmpleador;
    expect(a.salud).toBeGreaterThan(0);
  });

  it('confirmada por la empresa: exonera a quien gana menos de 10 SMMLV', () => {
    const a = slip({
      ...S,
      empresaExoneradaAportes: true,
      exoneracionConfirmada: true,
    }).aportesEmpleador;
    expect(a.salud).toBe(0);
    expect(a.sena).toBe(0);
    expect(a.icbf).toBe(0);
  });
});
