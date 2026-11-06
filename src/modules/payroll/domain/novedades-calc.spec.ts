import { describe, expect, it } from 'vitest';
import { liquidarAusencias, tramoEnPeriodo, vacacionesDisfrutadasDeNovedades } from './novedades-calc';
import { computeSlip } from './payroll-calc';
import { DEFAULT_PAYROLL_SETTINGS } from './payroll.constants';

/** Cifras redondas: salario de 3.000.000 (100.000 diarios) y SMMLV de 1.500.000 (50.000 diarios). */
const SAL = 3_000_000;
const SMMLV = 1_500_000;

describe('liquidarAusencias (decisión 3 del dueño)', () => {
  it('vacaciones: salario de los días, a cargo del empleador', () => {
    const r = liquidarAusencias([{ tipo: 'vacaciones', fechaInicio: '2026-10-05', fechaFin: '2026-10-19', diasHabiles: 10 }], '2026-10', SAL, SMMLV);
    expect(r.lineas[0]).toMatchObject({ dias: 15, valor: 1_500_000, pagador: 'empleador' });
    expect(r).toMatchObject({ diasRemunerados: 15, diasNoRemunerados: 0, totalRemunerado: 1_500_000 });
  });

  it('incapacidad común: 2/3 del salario, 2 días el empleador y el resto la EPS (Decreto 2943/2013, CST 227)', () => {
    const r = liquidarAusencias([{ tipo: 'incapacidad_comun', fechaInicio: '2026-10-01', fechaFin: '2026-10-10' }], '2026-10', SAL, SMMLV);
    expect(r.lineas[0]).toMatchObject({ dias: 10, valor: 666_667, pagador: 'eps', diasPorPagador: { empleador: 2, eps: 8 } });
  });

  it('incapacidad común: nunca menos del SMMLV diario', () => {
    const r = liquidarAusencias([{ tipo: 'incapacidad_comun', fechaInicio: '2026-10-01', fechaFin: '2026-10-02' }], '2026-10', SMMLV, SMMLV);
    // 2/3 de 50.000 = 33.333 < 50.000: se paga el mínimo.
    expect(r.lineas[0]).toMatchObject({ valor: 100_000, pagador: 'empleador' });
  });

  it('prórroga: del día 91 en adelante es la mitad', () => {
    const r = liquidarAusencias(
      [{ tipo: 'incapacidad_comun', fechaInicio: '2026-10-01', fechaFin: '2026-10-10', diasPreviosProrroga: 85 }],
      '2026-10',
      SAL,
      SMMLV,
    );
    // Días 86–90 a 2/3 (5 × 66.666,67) y 91–95 a 1/2 (5 × 50.000).
    expect(r.lineas[0]!.valor).toBe(583_333);
  });

  it('incapacidad que empezó el mes anterior: cuenta los días ya corridos', () => {
    const r = liquidarAusencias([{ tipo: 'incapacidad_comun', fechaInicio: '2026-09-29', fechaFin: '2026-10-03' }], '2026-10', SAL, SMMLV);
    expect(r.lineas[0]).toMatchObject({ fechaInicio: '2026-10-01', dias: 3, diasPorPagador: { eps: 3 } });
  });

  it('laboral 100 % a cargo de la ARL; maternidad 100 % EPS; remunerada 100 % empleador', () => {
    const r = liquidarAusencias(
      [
        { tipo: 'incapacidad_laboral', fechaInicio: '2026-10-01', fechaFin: '2026-10-05' },
        { tipo: 'licencia_maternidad', fechaInicio: '2026-10-06', fechaFin: '2026-10-15' },
        { tipo: 'licencia_remunerada', fechaInicio: '2026-10-16', fechaFin: '2026-10-17' },
      ],
      '2026-10',
      SAL,
      SMMLV,
    );
    expect(r.lineas.map((l) => [l.tipo, l.valor, l.pagador])).toEqual([
      ['incapacidad_laboral', 500_000, 'arl'],
      ['licencia_maternidad', 1_000_000, 'eps'],
      ['licencia_remunerada', 200_000, 'empleador'],
    ]);
  });

  it('licencia no remunerada: no paga y deja la base del aporte a pensión', () => {
    const r = liquidarAusencias([{ tipo: 'licencia_no_remunerada', fechaInicio: '2026-10-01', fechaFin: '2026-10-04' }], '2026-10', SAL, SMMLV);
    expect(r).toMatchObject({ diasRemunerados: 0, diasNoRemunerados: 4, totalRemunerado: 0, basePensionNoRemunerada: 400_000 });
  });

  it('recorta al mes: el fin de mes cuenta 30 y lo de otros meses no entra', () => {
    expect(tramoEnPeriodo('2026-09-20', '2026-11-05', '2026-10')).toEqual({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(tramoEnPeriodo('2026-11-01', '2026-11-05', '2026-10')).toBeNull();
    const r = liquidarAusencias([{ tipo: 'vacaciones', fechaInicio: '2026-10-25', fechaFin: '2026-11-10', diasHabiles: 12 }], '2026-10', SAL, SMMLV);
    expect(r.lineas[0]).toMatchObject({ fechaFin: '2026-10-31', dias: 6 });
  });

  it('sugiere los días hábiles de vacaciones disfrutados', () => {
    expect(
      vacacionesDisfrutadasDeNovedades([
        { tipo: 'vacaciones', fechaInicio: '2025-01-05', fechaFin: '2025-01-25', diasHabiles: 15 },
        { tipo: 'incapacidad_comun', fechaInicio: '2025-03-01', fechaFin: '2025-03-02' },
        { tipo: 'vacaciones', fechaInicio: '2026-01-05', fechaFin: '2026-01-12', diasHabiles: 6 },
      ]),
    ).toBe(21);
  });
});

describe('computeSlip con ausencias', () => {
  const s = { ...DEFAULT_PAYROLL_SETTINGS, smmlv: SMMLV, exoneracionConfirmada: true };

  it('vacaciones: entran al devengado y al IBC (Decreto 1406/1999 art. 40); el resto del mes es salario', () => {
    const aus = liquidarAusencias([{ tipo: 'vacaciones', fechaInicio: '2026-10-01', fechaFin: '2026-10-15', diasHabiles: 11 }], '2026-10', SAL, SMMLV);
    const b = computeSlip({ salarioBase: SAL, salaryType: 'ordinario', diasTrabajados: 15, ausencias: aus, fechaCorte: '2026-10-31' }, s);
    expect(b.devengados.salario).toBe(1_500_000);
    expect(b.devengados.ausencias).toBe(1_500_000);
    expect(b.devengados.ausenciaDetalle).toHaveLength(1);
    expect(b.ibc).toBe(3_000_000);
    expect(b.deducciones.salud).toBe(120_000);
    expect(b.devengados.total).toBe(3_000_000 + b.devengados.auxilioTransporte);
  });

  it('incapacidad común: el IBC es lo pagado y el mínimo se mide con los días cotizados', () => {
    const aus = liquidarAusencias([{ tipo: 'incapacidad_comun', fechaInicio: '2026-10-01', fechaFin: '2026-10-30' }], '2026-10', SMMLV, SMMLV);
    const b = computeSlip({ salarioBase: SMMLV, salaryType: 'ordinario', diasTrabajados: 0, ausencias: aus, fechaCorte: '2026-10-31' }, s);
    expect(b.devengados.ausencias).toBe(1_500_000); // piso del SMMLV
    expect(b.ibc).toBe(1_500_000);
    expect(b.devengados.auxilioTransporte).toBe(0); // sin días trabajados no hay auxilio
  });

  it('licencia no remunerada: no paga ni cotiza salud; el empleador aporta pensión sobre esos días', () => {
    const aus = liquidarAusencias([{ tipo: 'licencia_no_remunerada', fechaInicio: '2026-10-01', fechaFin: '2026-10-10' }], '2026-10', SAL, SMMLV);
    const b = computeSlip({ salarioBase: SAL, salaryType: 'ordinario', diasTrabajados: 20, ausencias: aus, fechaCorte: '2026-10-31' }, s);
    expect(b.devengados.ausencias).toBe(0);
    expect(b.ibc).toBe(2_000_000);
    expect(b.aportesEmpleador.pension).toBe(240_000 + 120_000); // 12 % de 2.000.000 + 12 % de 1.000.000
    expect(b.devengados.total).toBe(2_000_000 + b.devengados.auxilioTransporte);
  });
});
