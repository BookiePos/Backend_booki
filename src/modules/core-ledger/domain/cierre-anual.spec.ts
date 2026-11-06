import { describe, it, expect } from 'vitest';
import {
  SaldoResultado,
  anioValido,
  armarCierre,
  armarTraslado,
} from './cierre-anual';
import { ACC } from './ledger.constants';

/**
 * Asientos del cierre anual (R4 de la revisión 1.16). Lo que importa: cada
 * sede cuadra por separado (los informes por sede siguen cuadrando después
 * del cierre), la utilidad va al crédito de la 3605 y la pérdida al débito, y
 * las cuentas de saldo contrario (4175 devoluciones, 7205 o un gasto con
 * saldo acreedor) se cancelan por el lado que les corresponde.
 */
const S1 = '64b0000000000000000000a1';
const S2 = '64b0000000000000000000a2';

const saldo = (
  code: string,
  type: 'income' | 'expense',
  sedeId: string | null,
  debit: number,
  credit: number,
): SaldoResultado => ({ code, type, sedeId, debit, credit });

const cuadraPorSede = (renglones: ReturnType<typeof armarCierre>['renglones']) => {
  const neto = new Map<string | undefined, number>();
  for (const r of renglones) {
    neto.set(r.sedeId, (neto.get(r.sedeId) ?? 0) + (r.debit ?? 0) - (r.credit ?? 0));
  }
  return [...neto.values()].every((v) => v === 0);
};

describe('armarCierre', () => {
  it('con utilidad: cancela ingresos y gastos y acredita la 3605', () => {
    const { renglones, resultado } = armarCierre([
      saldo('4135', 'income', S1, 0, 1_000_000),
      saldo('6135', 'expense', S1, 600_000, 0),
      saldo('5105', 'expense', S1, 100_000, 0),
    ]);
    expect(resultado).toBe(300_000);
    expect(renglones).toContainEqual({ accountCode: '4135', debit: 1_000_000, sedeId: S1 });
    expect(renglones).toContainEqual({ accountCode: '6135', credit: 600_000, sedeId: S1 });
    expect(renglones).toContainEqual({ accountCode: '5105', credit: 100_000, sedeId: S1 });
    expect(renglones).toContainEqual({
      accountCode: ACC.RESULTADO_EJERCICIO,
      credit: 300_000,
      sedeId: S1,
    });
    expect(cuadraPorSede(renglones)).toBe(true);
  });

  it('con pérdida: debita la 3605', () => {
    const { renglones, resultado } = armarCierre([
      saldo('4135', 'income', S1, 0, 200_000),
      saldo('5105', 'expense', S1, 500_000, 0),
    ]);
    expect(resultado).toBe(-300_000);
    expect(renglones).toContainEqual({
      accountCode: ACC.RESULTADO_EJERCICIO,
      debit: 300_000,
      sedeId: S1,
    });
    expect(cuadraPorSede(renglones)).toBe(true);
  });

  it('las cuentas de saldo contrario (4175, 7205) se cancelan por su lado', () => {
    const { renglones, resultado } = armarCierre([
      saldo('4135', 'income', S1, 0, 1_000_000),
      // Devoluciones en ventas: ingreso con saldo DÉBITO → se acredita.
      saldo('4175', 'income', S1, 50_000, 0),
      // Costo con saldo crédito (p. ej. un ajuste) → se debita.
      saldo('7205', 'expense', S1, 0, 20_000),
    ]);
    expect(renglones).toContainEqual({ accountCode: '4175', credit: 50_000, sedeId: S1 });
    expect(renglones).toContainEqual({ accountCode: '7205', debit: 20_000, sedeId: S1 });
    expect(resultado).toBe(970_000);
    expect(cuadraPorSede(renglones)).toBe(true);
  });

  it('cuadra sede por sede y suma el resultado de la empresa', () => {
    const { renglones, resultado } = armarCierre([
      saldo('4135', 'income', S1, 0, 800_000),
      saldo('5105', 'expense', S1, 300_000, 0),
      saldo('4135', 'income', S2, 0, 100_000),
      saldo('5105', 'expense', S2, 400_000, 0),
      // Nivel empresa (sin sede), p. ej. un gasto financiero.
      saldo('5305', 'expense', null, 10_000, 0),
    ]);
    expect(resultado).toBe(190_000);
    expect(cuadraPorSede(renglones)).toBe(true);
    const r3605 = renglones.filter((r) => r.accountCode === ACC.RESULTADO_EJERCICIO);
    expect(r3605).toEqual(
      expect.arrayContaining([
        { accountCode: ACC.RESULTADO_EJERCICIO, credit: 500_000, sedeId: S1 },
        { accountCode: ACC.RESULTADO_EJERCICIO, debit: 300_000, sedeId: S2 },
        { accountCode: ACC.RESULTADO_EJERCICIO, debit: 10_000, sedeId: undefined },
      ]),
    );
  });

  it('una sede que da cero no lleva renglón en la 3605, y sin saldos no hay nada', () => {
    const { renglones } = armarCierre([
      saldo('4135', 'income', S1, 0, 100),
      saldo('5105', 'expense', S1, 100, 0),
    ]);
    expect(renglones.some((r) => r.accountCode === ACC.RESULTADO_EJERCICIO)).toBe(false);
    expect(armarCierre([]).renglones).toEqual([]);
  });
});

describe('armarTraslado', () => {
  it('lleva la utilidad y la pérdida de cada sede de la 3605 a la 3705', () => {
    const lineas = armarTraslado([
      { debit: 0, credit: 500_000, sedeId: S1 },
      { debit: 300_000, credit: 0, sedeId: S2 },
      { debit: 0, credit: 0, sedeId: null },
    ]);
    expect(lineas).toEqual([
      { accountCode: ACC.RESULTADO_EJERCICIO, debit: 500_000, sedeId: S1 },
      { accountCode: ACC.RESULTADOS_ANTERIORES, credit: 500_000, sedeId: S1 },
      { accountCode: ACC.RESULTADO_EJERCICIO, credit: 300_000, sedeId: S2 },
      { accountCode: ACC.RESULTADOS_ANTERIORES, debit: 300_000, sedeId: S2 },
    ]);
  });

  it('el traslado de un cierre deja la 3605 en cero', () => {
    const { renglones } = armarCierre([
      saldo('4135', 'income', S1, 0, 900),
      saldo('5105', 'expense', S2, 400, 0),
    ]);
    const r3605 = renglones
      .filter((r) => r.accountCode === ACC.RESULTADO_EJERCICIO)
      .map((r) => ({ debit: r.debit ?? 0, credit: r.credit ?? 0, sedeId: r.sedeId }));
    const tras = armarTraslado(r3605);
    const saldo3605 = [...renglones, ...tras]
      .filter((r) => r.accountCode === ACC.RESULTADO_EJERCICIO)
      .reduce((a, r) => a + (r.credit ?? 0) - (r.debit ?? 0), 0);
    expect(saldo3605).toBe(0);
  });
});

describe('anioValido', () => {
  it('acepta YYYY y rechaza lo demás', () => {
    expect(anioValido('2025')).toBe(2025);
    expect(anioValido('25')).toBeNull();
    expect(anioValido('2025a')).toBeNull();
    expect(anioValido('1999')).toBeNull();
  });
});
