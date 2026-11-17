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

import { LedgerPostingService, lineasPagoPrestacion } from './ledger-posting.service';
import { esOrigenReservado } from '../domain/journal-entry.indices';

const sum = (ls: { debit?: number; credit?: number }[], k: 'debit' | 'credit') => ls.reduce((t, l) => t + (l[k] ?? 0), 0);
const plano = (ls: { accountCode: string; debit?: number; credit?: number }[]) => ls.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0]);

describe('lineasPagoPrestacion', () => {
  it('consume la 2610 contra bancos cuando sale por transferencia, consignación o cheque', () => {
    for (const medio of ['47', '42', '20']) {
      expect(plano(lineasPagoPrestacion({ monto: 750_000, retencionFuente: 0, medio }, 'sede1'))).toEqual([
        ['2610', 750_000, 0],
        ['1110', 0, 750_000],
      ]);
    }
  });

  it('en efectivo sale de la caja', () => {
    const ls = lineasPagoPrestacion({ monto: 750_000, retencionFuente: 0, medio: '10' }, 'sede1');
    expect(plano(ls)).toEqual([
      ['2610', 750_000, 0],
      ['1105', 0, 750_000],
    ]);
    expect(ls.every((l) => l.sedeId === 'sede1')).toBe(true);
  });

  it('con retención: la 2365 por lo retenido y el banco por el neto; cuadra exacto', () => {
    const ls = lineasPagoPrestacion({ monto: 6_000_000, retencionFuente: 150_000, medio: '47' });
    expect(plano(ls)).toEqual([
      ['2610', 6_000_000, 0],
      ['2365', 0, 150_000],
      ['1110', 0, 5_850_000],
    ]);
    for (const p of [
      { monto: 1, retencionFuente: 0, medio: '10' },
      { monto: 333_333, retencionFuente: 33_333, medio: '47' },
      { monto: 9_999_999, retencionFuente: 9_999_998, medio: '42' },
    ]) {
      const l = lineasPagoPrestacion(p);
      expect(sum(l, 'debit')).toBe(sum(l, 'credit'));
      expect(sum(l, 'debit')).toBe(p.monto);
    }
  });

  it('sin monto no asienta; negativos o retención que iguala el pago lanzan', () => {
    expect(lineasPagoPrestacion({ monto: 0, retencionFuente: 0, medio: '47' })).toEqual([]);
    expect(() => lineasPagoPrestacion({ monto: -1, retencionFuente: 0, medio: '47' })).toThrow(/negativo/);
    expect(() => lineasPagoPrestacion({ monto: 100, retencionFuente: -1, medio: '47' })).toThrow(/negativo/);
    expect(() => lineasPagoPrestacion({ monto: 100, retencionFuente: 100, medio: '47' })).toThrow(/retención/);
  });
});

describe('LedgerPostingService · pago de prestaciones', () => {
  function armar(existente = false, falla = false) {
    const ledger = {
      findBySource: vi.fn(async () => (existente ? { _id: 'x' } : null)),
      post: vi.fn(async () => {
        if (falla) throw new Error('periodo cerrado');
      }),
      reverseBySource: vi.fn(async () => null),
    };
    const conciliacion = { registrar: vi.fn(async () => undefined) };
    return { ledger, conciliacion, service: new LedgerPostingService(ledger as never, conciliacion as never) };
  }
  const input = {
    pagoId: 'P1',
    date: '2026-06-15',
    concepto: 'prima de servicios',
    employeeName: 'Ana',
    partes: { monto: 750_000, retencionFuente: 0, medio: '47' },
    userEmail: 'o@x.co',
  };

  it('postea con sourceType pago_prestacion, el id del pago y la fecha real del pago', async () => {
    const t = armar();
    expect(await t.service.postPagoPrestacion(input)).toBe(true);
    expect(t.ledger.post).toHaveBeenCalledTimes(1);
    expect(t.ledger.post).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'pago_prestacion', sourceId: 'P1', date: '2026-06-15', memo: 'Pago de prima de servicios Ana' }),
    );
  });

  it('idempotente: si el asiento ya existe, un reintento no postea otro', async () => {
    const t = armar(true);
    expect(await t.service.postPagoPrestacion(input)).toBe(true);
    await t.service.postPagoPrestacion(input);
    expect(t.ledger.post).not.toHaveBeenCalled();
  });

  it('si el libro falla, devuelve false y deja el pendiente de conciliación', async () => {
    const t = armar(false, true);
    expect(await t.service.postPagoPrestacion(input)).toBe(false);
    expect(t.conciliacion.registrar).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'pago_prestacion', sourceId: 'P1', operacion: 'post' }));
  });

  it('contra-asiento por (pago_prestacion, id); el origen queda reservado para el sistema', async () => {
    const t = armar();
    await t.service.reversePagoPrestacion('P1', 'o@x.co');
    expect(t.ledger.reverseBySource).toHaveBeenCalledWith('pago_prestacion', 'P1', 'o@x.co');
    expect(esOrigenReservado('pago_prestacion')).toBe(true);
  });
});
