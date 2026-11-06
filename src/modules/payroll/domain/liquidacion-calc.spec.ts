import { describe, it, expect } from 'vitest';

import { computeLiquidacion, dias360, dias360Inclusivo } from './liquidacion-calc';
import { DEFAULT_PAYROLL_SETTINGS } from './payroll.constants';

/**
 * Liquidación definitiva al terminar el contrato.
 *
 * Es el pago más grande y menos frecuente de la nómina, y el que nadie revisa
 * dos veces: se calcula una sola vez, por una persona que ya se fue. Un error
 * aquí no lo detecta ningún cuadre posterior.
 *
 * Se usan cifras redondas (salario de 1.000.000, auxilio de 200.000) para que
 * cada resultado se pueda verificar a mano, no porque sean los valores reales.
 */
describe('computeLiquidacion', () => {
  /** Parámetros con cifras redondas para poder comprobar la aritmética a ojo. */
  const s = {
    ...DEFAULT_PAYROLL_SETTINGS,
    smmlv: 1_000_000,
    auxilioTransporte: 200_000,
    auxTransporteMaxSmmlv: 2,
    exoneracionSmmlv: 10,
  };

  /** Un año exacto de contrato, salario de un mínimo, renuncia voluntaria. */
  const base = {
    salarioBase: 1_000_000,
    salaryType: 'ordinario' as const,
    fechaInicio: '2025-01-01',
    fechaFin: '2025-12-31',
    motivo: 'renuncia' as const,
  };

  describe('dias360Inclusivo (cuenta de la liquidación de retiro)', () => {
    it('cuenta el día del ingreso y el del retiro: 1-ene a 20-oct son 290', () => {
      expect(dias360Inclusivo('2026-01-01', '2026-10-20')).toBe(290);
    });
    it('un año completo, 1-ene a 31-dic, son 360', () => {
      expect(dias360Inclusivo('2025-01-01', '2025-12-31')).toBe(360);
    });
    it('febrero cerrado cuenta 30, y un solo día cuenta 1', () => {
      expect(dias360Inclusivo('2026-02-01', '2026-02-28')).toBe(30);
      expect(dias360Inclusivo('2026-03-05', '2026-03-05')).toBe(1);
    });
    it('el 31 cuenta como 30 y una fecha invertida da 0', () => {
      expect(dias360Inclusivo('2026-01-31', '2026-03-31')).toBe(61);
      expect(dias360Inclusivo('2026-03-01', '2026-01-01')).toBe(0);
    });
  });

  describe('dias360', () => {
    it('un mes calendario son 30 días', () => {
      expect(dias360('2026-01-01', '2026-02-01')).toBe(30);
    });

    it('un año son 360 días', () => {
      expect(dias360('2025-01-01', '2026-01-01')).toBe(360);
    });

    it('el día 31 cuenta como 30: los meses son todos iguales', () => {
      expect(dias360('2026-01-31', '2026-03-31')).toBe(60);
    });

    it('una fecha de retiro anterior al ingreso no da días negativos', () => {
      expect(dias360('2026-03-01', '2026-01-01')).toBe(0);
    });
  });

  describe('prestaciones', () => {
    it('el auxilio de transporte entra a la base prestacional', () => {
      const r = computeLiquidacion(base, s);

      expect(r.auxilioTransporte).toBe(200_000);
      expect(r.basePrestacional).toBe(1_200_000);
    });

    it('un salario por encima del tope no lleva auxilio de transporte', () => {
      // Tope: 2 SMMLV = 2.000.000.
      const r = computeLiquidacion({ ...base, salarioBase: 2_500_000 }, s);

      expect(r.auxilioTransporte).toBe(0);
      expect(r.basePrestacional).toBe(2_500_000);
    });

    it('un año completo son un mes de cesantías sobre la base prestacional', () => {
      const r = computeLiquidacion(base, s);

      expect(r.diasLiquidados).toBe(360);
      expect(r.cesantias).toBe(1_200_000);
    });

    it('los intereses son el 12% anual de las cesantías', () => {
      const r = computeLiquidacion(base, s);

      expect(r.interesesCesantias).toBe(144_000);
    });

    it('medio año son medias cesantías: es proporcional al tiempo', () => {
      const r = computeLiquidacion({ ...base, fechaFin: '2025-06-30' }, s);

      expect(r.diasLiquidados).toBe(180);
      expect(r.cesantias).toBe(600_000);
      expect(r.interesesCesantias).toBe(36_000);
    });

    it('las vacaciones son medio día por día trabajado, sin auxilio', () => {
      const r = computeLiquidacion(base, s);

      // 15 días de salario por año: 1.000.000 × 360 / 720.
      expect(r.vacaciones).toBe(500_000);
    });

    it('la prima cuenta solo desde el semestre en curso, no desde el ingreso', () => {
      // Retiro el 1 de julio: el segundo semestre acaba de empezar, así que la
      // prima del primero ya se pagó y solo se liquida ese día.
      const r = computeLiquidacion({ ...base, fechaFin: '2025-07-01' }, s);

      expect(r.diasPrima).toBe(1);
      expect(r.prima).toBe(3_333); // 1.200.000 × 1 / 360
    });

    it('retiro a mitad del semestre: prima proporcional a esos días', () => {
      // Del 1 de julio al 30 de septiembre son 90 días del semestre en curso.
      const r = computeLiquidacion(
        { ...base, fechaInicio: '2024-01-01', fechaFin: '2025-09-30' },
        s,
      );

      expect(r.prima).toBe(300_000); // 1.200.000 × 90 / 360
    });

    it('el salario integral ya incluye prestaciones: no se liquidan aparte', () => {
      const r = computeLiquidacion(
        { ...base, salaryType: 'integral', salarioBase: 15_000_000 },
        s,
      );

      expect(r.cesantias).toBe(0);
      expect(r.interesesCesantias).toBe(0);
      expect(r.prima).toBe(0);
      expect(r.auxilioTransporte).toBe(0);
      // Las vacaciones SÍ se liquidan: no son prestación, son descanso causado.
      expect(r.vacaciones).toBeGreaterThan(0);
    });
  });

  describe('indemnización', () => {
    it('renunciar no genera indemnización', () => {
      expect(computeLiquidacion(base, s).indemnizacion).toBe(0);
    });

    it('el despido con justa causa tampoco', () => {
      const r = computeLiquidacion({ ...base, motivo: 'justa_causa' }, s);

      expect(r.indemnizacion).toBe(0);
    });

    it('sin justa causa e indefinido con menos de un año: 30 días de salario', () => {
      const r = computeLiquidacion(
        { ...base, motivo: 'sin_justa_causa', fechaFin: '2025-06-30' },
        s,
      );

      // Salario diario 33.333,33 × 30 días.
      expect(r.indemnizacion).toBe(1_000_000);
    });

    it('sin justa causa: cada año adicional suma 20 días más', () => {
      const r = computeLiquidacion(
        {
          ...base,
          motivo: 'sin_justa_causa',
          fechaInicio: '2024-01-01',
          fechaFin: '2025-12-31',
        },
        s,
      );

      // 2 años: 30 + 20 = 50 días × 33.333,33.
      expect(r.indemnizacion).toBe(1_666_667);
    });

    it('un salario alto indemniza menos días por año: 20 y 15', () => {
      // Por encima de 10 SMMLV el artículo 64 cambia de tramo.
      const r = computeLiquidacion(
        {
          ...base,
          salarioBase: 12_000_000,
          motivo: 'sin_justa_causa',
          fechaInicio: '2024-01-01',
          fechaFin: '2025-12-31',
        },
        s,
      );

      // 2 años: 20 + 15 = 35 días × (12.000.000 / 30).
      expect(r.indemnizacion).toBe(14_000_000);
      expect(r.detalleIndemnizacion).toContain('10 SMMLV');
    });

    it('en contrato a término fijo se indemnizan los días que faltaban', () => {
      const r = computeLiquidacion(
        {
          ...base,
          motivo: 'sin_justa_causa',
          contractType: 'fijo',
          diasFaltantesContrato: 90,
        },
        s,
      );

      expect(r.indemnizacion).toBe(3_000_000); // 33.333,33 × 90
      expect(r.detalleIndemnizacion).toContain('90 días');
    });

    it('término fijo sin días faltantes no indemniza', () => {
      const r = computeLiquidacion(
        {
          ...base,
          motivo: 'sin_justa_causa',
          contractType: 'fijo',
          diasFaltantesContrato: 0,
        },
        s,
      );

      expect(r.indemnizacion).toBe(0);
    });
  });

  describe('total', () => {
    it('el total es exactamente la suma de sus partes', () => {
      const r = computeLiquidacion(
        {
          ...base,
          motivo: 'sin_justa_causa',
          fechaInicio: '2024-01-01',
          fechaFin: '2025-12-31',
          salariosPendientes: 450_000,
        },
        s,
      );

      expect(r.total).toBe(
        r.cesantias +
          r.interesesCesantias +
          r.prima +
          r.vacaciones +
          r.indemnizacion +
          r.salariosPendientes,
      );
    });

    it('todo importe sale en pesos enteros', () => {
      const r = computeLiquidacion(
        { ...base, salarioBase: 1_333_333, fechaFin: '2025-08-17' },
        s,
      );

      for (const valor of [
        r.cesantias,
        r.interesesCesantias,
        r.prima,
        r.vacaciones,
        r.indemnizacion,
        r.total,
      ]) {
        expect(Number.isInteger(valor)).toBe(true);
      }
    });

    it('un contrato de un solo día liquida ese día y no revienta', () => {
      const r = computeLiquidacion(
        { ...base, fechaInicio: '2026-01-01', fechaFin: '2026-01-01' },
        s,
      );

      expect(r.diasLiquidados).toBe(1);
      expect(r.cesantias).toBe(3_333); // 1.200.000 × 1 / 360
      expect(Number.isInteger(r.total)).toBe(true);
    });
  });

  describe('base de días (revisión contable de la Fase 8)', () => {
    const largo = { ...base, fechaInicio: '2023-03-01', fechaFin: '2026-10-20' };

    it('cesantías e intereses solo desde el 1 de enero del año del retiro (Ley 50/1990 art. 99)', () => {
      const r = computeLiquidacion(largo, s);
      expect(r.inicioCesantias).toBe('2026-01-01');
      expect(r.diasCesantias).toBe(290);
      expect(r.cesantias).toBe(966_667); // 1.200.000 × 290 / 360
      expect(r.interesesCesantias).toBe(93_444); // 966.667 × 290 × 12 % / 360
      // La antigüedad sigue contando desde el ingreso.
      expect(r.diasLiquidados).toBe(1_310);
    });

    it('si el ingreso es del mismo año, desde el ingreso; y se puede sobrescribir', () => {
      expect(computeLiquidacion({ ...largo, fechaInicio: '2026-03-01' }, s).inicioCesantias).toBe('2026-03-01');
      const r = computeLiquidacion({ ...largo, inicioCesantias: '2025-01-01' }, s);
      expect(r.diasCesantias).toBe(650);
    });

    it('vacaciones: causadas menos disfrutadas (CST arts. 186 y 189)', () => {
      // 1.310 días → 54,58 días hábiles causados; disfrutó 45 → quedan 9,58.
      const r = computeLiquidacion({ ...largo, vacacionesDisfrutadasDias: 45 }, s);
      expect(r.diasVacacionesCausados).toBe(54.58);
      expect(r.diasVacacionesPendientes).toBe(9.58);
      expect(r.vacaciones).toBe(319_444); // 1.000.000 / 30 × 9,5833…
      // Si disfrutó más de lo causado, no queda saldo negativo.
      expect(computeLiquidacion({ ...largo, vacacionesDisfrutadasDias: 80 }, s).vacaciones).toBe(0);
    });

    it('obra o labor sin justa causa: nunca menos de 15 días (art. 64 CST)', () => {
      const r = computeLiquidacion({ ...base, motivo: 'sin_justa_causa', contractType: 'obra_labor', diasFaltantesContrato: 5 }, s);
      expect(r.indemnizacion).toBe(500_000); // 33.333,33 × 15
      expect(r.detalleIndemnizacion).toContain('mínimo legal');
      const largo2 = computeLiquidacion({ ...base, motivo: 'sin_justa_causa', contractType: 'obra_labor', diasFaltantesContrato: 40 }, s);
      expect(largo2.indemnizacion).toBe(1_333_333);
    });
  });
});
