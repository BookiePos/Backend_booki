import { describe, it, expect } from 'vitest';
import {
  SplitPaymentError,
  cashAmountOf,
  salePartsOf,
  splitPayment,
  treasurySourceId,
} from './sale-payments';

/** Ítem 6.4: datáfono, Nequi, Daviplata y QR como detalle de card/transfer. */
describe('splitPayment · canales digitales', () => {
  it('efectivo + Nequi + Daviplata: el medio principal suma las dos billeteras', () => {
    const r = splitPayment(
      [
        { method: 'cash', amount: 40_000 },
        { method: 'transfer', channel: 'nequi', amount: 30_000, reference: '3001234567' },
        { method: 'transfer', channel: 'daviplata', amount: 30_000 },
      ],
      100_000,
      100_000,
    );
    expect(r.parts).toHaveLength(3);
    expect(r.parts.reduce((a, p) => a + p.amount, 0)).toBe(100_000);
    expect(r.primaryMethod).toBe('transfer');
    expect(r.primaryDetail).toBeUndefined();
  });

  it('dos Nequi se juntan en una parte y conservan ambas referencias', () => {
    const r = splitPayment(
      [
        { method: 'transfer', channel: 'nequi', amount: 20_000, reference: 'A1' },
        { method: 'transfer', channel: 'nequi', amount: 30_000, reference: 'B2' },
      ],
      50_000,
      50_000,
    );
    expect(r.parts).toEqual([
      { method: 'transfer', channel: 'nequi', amount: 50_000, reference: 'A1 / B2' },
    ]);
    expect(r.primaryDetail).toEqual({ channel: 'nequi', reference: 'A1 / B2' });
  });

  it('datáfono de débito y de crédito son partes distintas', () => {
    const r = splitPayment(
      [
        { method: 'card', channel: 'datafono', cardType: 'debit', franchise: 'visa', amount: 10_000 },
        { method: 'card', channel: 'datafono', cardType: 'credit', franchise: 'visa', amount: 15_000 },
      ],
      25_000,
      25_000,
    );
    expect(r.parts).toHaveLength(2);
  });

  it('la parte digital no puede pasarse del total: el vuelto solo sale del efectivo', () => {
    expect(() =>
      splitPayment(
        [
          { method: 'cash', amount: 10_000 },
          { method: 'transfer', channel: 'qr', amount: 60_000 },
        ],
        50_000,
        50_000,
      ),
    ).toThrow(SplitPaymentError);
  });

  it('rechaza un canal que no corresponde al medio', () => {
    expect(() =>
      splitPayment([{ method: 'card', channel: 'nequi', amount: 5_000 }], 5_000, 5_000),
    ).toThrow(/se cobra como transfer/);
  });

  it('rechaza franquicia fuera del datáfono y referencias con caracteres raros', () => {
    expect(() =>
      splitPayment(
        [{ method: 'transfer', channel: 'qr', franchise: 'visa', amount: 5_000 }],
        5_000,
        5_000,
      ),
    ).toThrow(/solo aplican al datáfono/);
    expect(() =>
      splitPayment(
        [{ method: 'card', channel: 'datafono', amount: 5_000, reference: '<script>' }],
        5_000,
        5_000,
      ),
    ).toThrow(/referencia/);
    expect(() =>
      splitPayment([{ method: 'cash', amount: 5_000, reference: '123' }], 5_000, 5_000),
    ).toThrow(/pagos digitales/);
  });

  it('el pago sin canal sigue igual que antes', () => {
    const r = splitPayment([{ method: 'card', amount: 9_000 }], 9_000, 9_000);
    expect(r.parts).toEqual([{ method: 'card', amount: 9_000 }]);
    expect(r.primaryDetail).toBeUndefined();
  });
});

describe('lectura de ventas con canal', () => {
  it('el arqueo no ve estos medios: cashAmountOf solo cuenta el efectivo', () => {
    const sale = {
      total: 100_000,
      payments: [
        { method: 'cash', amount: 20_000 },
        { method: 'card', amount: 30_000, channel: 'datafono' as const, franchise: 'visa' as const },
        { method: 'transfer', amount: 25_000, channel: 'nequi' as const },
        { method: 'transfer', amount: 25_000, channel: 'qr' as const },
      ],
    };
    expect(cashAmountOf(sale)).toBe(20_000);
    expect(salePartsOf(sale)[1]).toMatchObject({ channel: 'datafono', franchise: 'visa' });
  });

  it('una venta de un solo medio con canal lo conserva en su única parte', () => {
    const parts = salePartsOf({
      total: 40_000,
      tip: 4_000,
      payment: { method: 'transfer', channel: 'daviplata', reference: '99' },
    });
    expect(parts).toEqual([
      { method: 'transfer', amount: 44_000, channel: 'daviplata', reference: '99' },
    ]);
  });

  it('el sourceId de tesorería distingue canales del mismo medio', () => {
    const a = treasurySourceId('s1', 'transfer', true, { channel: 'nequi' });
    const b = treasurySourceId('s1', 'transfer', true, { channel: 'daviplata' });
    expect(a).not.toBe(b);
    expect(treasurySourceId('s1', 'transfer', true)).toBe('s1:transfer');
    expect(treasurySourceId('s1', 'card', false, { channel: 'datafono' })).toBe('s1');
    expect(a.startsWith('s1:')).toBe(true);
  });
});
