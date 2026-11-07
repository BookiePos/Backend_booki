import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { LedgerPostingService, lineasLiquidacionRetiro, type PartesLiquidacion } from './ledger-posting.service';

/** Caso con indemnización: 2.000.000 de indemnización gravada con retención. */
const CASO: PartesLiquidacion = {
  cesantias: 1_500_000,
  interesesCesantias: 90_000,
  prima: 750_000,
  vacaciones: 400_000,
  indemnizacion: 2_000_000,
  salariosPendientes: 0,
  retencionFuente: 120_000,
};
const sum = (ls: { debit?: number; credit?: number }[], k: 'debit' | 'credit') => ls.reduce((t, l) => t + (l[k] ?? 0), 0);

describe('lineasLiquidacionRetiro', () => {
  it('consume la 2610, lleva la indemnización al gasto y la retención a la 2365', () => {
    const ls = lineasLiquidacionRetiro(CASO, 'sede1');
    expect(ls.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0])).toEqual([
      ['2610', 2_740_000, 0],
      ['5105', 2_000_000, 0],
      ['2365', 0, 120_000],
      ['2505', 0, 4_620_000],
    ]);
    expect(ls.every((l) => l.sedeId === 'sede1')).toBe(true);
  });

  it('cuadra exacto (débitos == créditos) en varios casos', () => {
    const casos: PartesLiquidacion[] = [
      CASO,
      { ...CASO, indemnizacion: 0, retencionFuente: 0 },
      { cesantias: 333_333, interesesCesantias: 13_333, prima: 166_667, vacaciones: 100_001, indemnizacion: 0, salariosPendientes: 50_000, retencionFuente: 0 },
      { cesantias: 0, interesesCesantias: 0, prima: 0, vacaciones: 0, indemnizacion: 1_000_000, salariosPendientes: 0, retencionFuente: 1_000_000 },
    ];
    for (const c of casos) {
      const ls = lineasLiquidacionRetiro(c);
      expect(sum(ls, 'debit')).toBe(sum(ls, 'credit'));
    }
  });

  it('sin monto no asienta; retención mayor al total o negativos lanzan', () => {
    expect(lineasLiquidacionRetiro({ ...CASO, cesantias: 0, interesesCesantias: 0, prima: 0, vacaciones: 0, indemnizacion: 0, retencionFuente: 0 })).toEqual([]);
    expect(() => lineasLiquidacionRetiro({ ...CASO, retencionFuente: 9_999_999 })).toThrow(/retención/);
    expect(() => lineasLiquidacionRetiro({ ...CASO, prima: -1 })).toThrow(/negativo/);
  });
});

describe('LedgerPostingService · liquidación de retiro', () => {
  function armar(existente = false) {
    const ledger = {
      findBySource: vi.fn(async () => (existente ? { _id: 'x' } : null)),
      post: vi.fn(async () => undefined),
      reverseBySource: vi.fn(async () => null),
    };
    return { ledger, service: new LedgerPostingService(ledger as never, { registrar: vi.fn() } as never) };
  }
  const input = { liquidacionId: 'L1', date: '2026-10-20', employeeName: 'Ana', partes: CASO, userEmail: 'o@x.co' };

  it('postea con sourceType liquidacion_retiro y el id de la liquidación', async () => {
    const t = armar();
    await t.service.postLiquidacionRetiro(input);
    expect(t.ledger.post).toHaveBeenCalledTimes(1);
    expect(t.ledger.post).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'liquidacion_retiro', sourceId: 'L1', date: '2026-10-20' }));
  });

  it('idempotente: si el asiento ya existe, un reintento no postea otro', async () => {
    const t = armar(true);
    await t.service.postLiquidacionRetiro(input);
    await t.service.postLiquidacionRetiro(input);
    expect(t.ledger.post).not.toHaveBeenCalled();
  });

  it('contra-asiento: reversa por (liquidacion_retiro, id)', async () => {
    const t = armar();
    await t.service.reverseLiquidacionRetiro('L1', 'o@x.co');
    expect(t.ledger.reverseBySource).toHaveBeenCalledWith('liquidacion_retiro', 'L1', 'o@x.co');
  });
});
