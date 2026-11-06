import { describe, expect, it, vi } from 'vitest';

// lineasNominaCausada vive en un servicio que importa esquemas: se neutralizan los decoradores.
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { lineasNominaCausada } from '../../core-ledger/application/ledger-posting.service';
import { ACC } from '../../core-ledger/domain/ledger.constants';
import { diasCalendario, liquidarAusencias, tramoEnPeriodo, vacacionesDisfrutadasDeNovedades } from './novedades-calc';
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
    expect(r.lineas[0]).toMatchObject({ fechaFin: '2026-10-31', dias: 7 });
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

describe('liquidarAusencias: días calendario (revisión D1)', () => {
  const dias = (desde: string, hasta: string, periodo: string, tipo: any = 'vacaciones') =>
    liquidarAusencias([{ tipo, fechaInicio: desde, fechaFin: hasta, diasHabiles: 1 }], periodo, SAL, SMMLV).lineas[0]?.dias;

  it('febrero: del 20 al 28 son 9; el mes entero da 30 (también en bisiesto)', () => {
    expect(dias('2026-02-20', '2026-02-28', '2026-02')).toBe(9);
    expect(dias('2026-02-01', '2026-02-28', '2026-02')).toBe(30);
    expect(dias('2028-02-01', '2028-02-29', '2028-02')).toBe(30);
    expect(dias('2028-02-20', '2028-02-29', '2028-02')).toBe(10);
  });

  it('meses de 31: el día 31 cuenta, pero el mes entero se topa en 30', () => {
    expect(dias('2026-10-25', '2026-10-31', '2026-10')).toBe(7);
    expect(dias('2026-10-01', '2026-10-31', '2026-10')).toBe(30);
    expect(diasCalendario('2026-01-28', '2026-02-03')).toBe(7);
  });

  it('incapacidad del 28 de enero al 3 de febrero: 4 + 3 días y la prórroga corre en calendario', () => {
    const n = [{ tipo: 'incapacidad_comun' as const, fechaInicio: '2026-01-28', fechaFin: '2026-02-03' }];
    const ene = liquidarAusencias(n, '2026-01', SAL, SMMLV).lineas[0]!;
    const feb = liquidarAusencias(n, '2026-02', SAL, SMMLV).lineas[0]!;
    expect(ene).toMatchObject({ dias: 4, diasPorPagador: { empleador: 2, eps: 2 } });
    expect(feb).toMatchObject({ dias: 3, diasPorPagador: { eps: 3 } });
    expect(ene.dias + feb.dias).toBe(7);
  });

  it('el umbral de 90 días se cuenta en calendario a través de los meses', () => {
    // Del 1-ene al 31-mar son 90 días calendario: el 1-abr es el día 91 (mitad).
    const n = [{ tipo: 'incapacidad_comun' as const, fechaInicio: '2026-01-01', fechaFin: '2026-04-02' }];
    const abr = liquidarAusencias(n, '2026-04', SAL, SMMLV).lineas[0]!;
    expect(abr).toMatchObject({ dias: 2, valor: 100_000 }); // 2 × 50.000 (1/2 de 100.000)
    const mar = liquidarAusencias(n, '2026-03', SAL, SMMLV).lineas[0]!;
    expect(mar.dias).toBe(30); // marzo entero, topado en 30
  });
});

describe('liquidarAusencias: salario integral y promedio (revisión D2 y art. 192)', () => {
  it('integral: incapacidad y licencia sobre el 70 % (IBC, art. 132 CST); vacaciones sobre el salario', () => {
    const n = [
      { tipo: 'incapacidad_laboral' as const, fechaInicio: '2026-10-01', fechaFin: '2026-10-10' },
      { tipo: 'vacaciones' as const, fechaInicio: '2026-10-11', fechaFin: '2026-10-20', diasHabiles: 8 },
    ];
    const r = liquidarAusencias(n, '2026-10', 30_000_000, SMMLV, { factorIntegral: 0.7 });
    expect(r.lineas.map((l) => l.valor)).toEqual([7_000_000, 10_000_000]);
  });

  it('vacaciones con salario promedio: se usa el promedio', () => {
    const r = liquidarAusencias(
      [{ tipo: 'vacaciones', fechaInicio: '2026-10-01', fechaFin: '2026-10-10', diasHabiles: 8, salarioPromedio: 3_600_000 }],
      '2026-10',
      SAL,
      SMMLV,
    );
    expect(r.lineas[0]!.valor).toBe(1_200_000);
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

  it('licencia no remunerada: 16 % de pensión, 12 % empleador y 4 % descontado al trabajador (revisión D5)', () => {
    const aus = liquidarAusencias([{ tipo: 'licencia_no_remunerada', fechaInicio: '2026-10-01', fechaFin: '2026-10-10' }], '2026-10', SAL, SMMLV);
    const b = computeSlip({ salarioBase: SAL, salaryType: 'ordinario', diasTrabajados: 20, ausencias: aus, fechaCorte: '2026-10-31' }, s);
    expect(b.deducciones.pensionLicenciaNR).toBe(40_000); // 4 % de 1.000.000
    expect(b.deducciones.total).toBe(b.deducciones.salud + b.deducciones.pension + b.deducciones.fsp + b.deducciones.retencionFuente + b.deducciones.otras + 40_000);
    // Con el mínimo, la base tiene piso de 1 SMMLV.
    const min = liquidarAusencias([{ tipo: 'licencia_no_remunerada', fechaInicio: '2026-10-01', fechaFin: '2026-10-30' }], '2026-10', 1_000_000, SMMLV);
    expect(min.basePensionNoRemunerada).toBe(1_500_000);
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

describe('salario integral: IBC de las ausencias (revisión N1 y N2)', () => {
  const s = { ...DEFAULT_PAYROLL_SETTINGS, smmlv: SMMLV, exoneracionConfirmada: true };
  const INTEGRAL = 30_000_000; // 1.000.000 diarios

  it('N1: el IBC de los días de incapacidad es el 70 % del salario (sin doble factor)', () => {
    const aus = liquidarAusencias(
      [{ tipo: 'incapacidad_laboral', fechaInicio: '2026-10-01', fechaFin: '2026-10-10' }],
      '2026-10',
      INTEGRAL,
      SMMLV,
      { factorIntegral: 0.7 },
    );
    expect(aus.totalRemunerado).toBe(7_000_000);
    const b = computeSlip({ salarioBase: INTEGRAL, salaryType: 'integral', diasTrabajados: 20, ausencias: aus, fechaCorte: '2026-10-31' }, s);
    // 20 días de salario al 70 % (14.000.000) + 10 días de incapacidad ya al 70 % (7.000.000).
    expect(b.ibc).toBe(21_000_000);
  });

  it('N2: la licencia remunerada va al 100 % aunque el salario sea integral, y el IBC le aplica el 70 %', () => {
    const aus = liquidarAusencias(
      [{ tipo: 'licencia_remunerada', fechaInicio: '2026-10-01', fechaFin: '2026-10-03' }],
      '2026-10',
      INTEGRAL,
      SMMLV,
      { factorIntegral: 0.7 },
    );
    expect(aus.lineas[0]!.valor).toBe(3_000_000);
    expect(aus.pagoAlSalario).toBe(3_000_000);
    const b = computeSlip({ salarioBase: INTEGRAL, salaryType: 'integral', diasTrabajados: 27, ausencias: aus, fechaCorte: '2026-10-31' }, s);
    expect(b.ibc).toBe(21_000_000); // (27.000.000 + 3.000.000) × 70 %
  });
});

describe('colilla con solo licencia no remunerada', () => {
  const s = { ...DEFAULT_PAYROLL_SETTINGS, smmlv: SMMLV, exoneracionConfirmada: true };

  it('neto negativo por el 4 % de pensión: queda a cargo del empleado (1365) y el asiento cuadra', () => {
    const aus = liquidarAusencias([{ tipo: 'licencia_no_remunerada', fechaInicio: '2026-10-01', fechaFin: '2026-10-31' }], '2026-10', SAL, SMMLV);
    const b = computeSlip({ salarioBase: SAL, salaryType: 'ordinario', diasTrabajados: 0, ausencias: aus, fechaCorte: '2026-10-31' }, s);
    expect(b.devengados.total).toBe(0);
    expect(b.deducciones.pensionLicenciaNR).toBe(120_000); // 4 % de 3.000.000
    expect(b.netoPagar).toBe(-120_000);
    // Así arma closeRun las partes: el neto negativo va como saldo a cargo del empleado.
    const lineas = lineasNominaCausada({
      neto: 0,
      saldoACargoEmpleados: 120_000,
      seguridadSocialEmpleado: b.deducciones.salud + b.deducciones.pension + b.deducciones.fsp + (b.deducciones.pensionLicenciaNR ?? 0),
      retencionFuente: 0,
      fiado: 0,
      otrasDeducciones: 0,
      arrastre: 0,
      aportesEmpleador: b.aportesEmpleador.total,
      provisiones: b.provisiones.total,
    });
    const debe = lineas.reduce((t, l) => t + (l.debit ?? 0), 0);
    const haber = lineas.reduce((t, l) => t + (l.credit ?? 0), 0);
    expect(debe).toBe(haber);
    expect(lineas.find((l) => l.accountCode === ACC.CXC_TRABAJADORES)?.debit).toBe(120_000);
  });
});
