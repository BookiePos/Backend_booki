import { describe, it, expect } from 'vitest';
import {
  SplitPaymentError,
  cashAmountOf,
  hasCreditPart,
  salePartsOf,
  splitPayment,
  treasurySourceId,
  treasurySourceIds,
} from './sale-payments';

/**
 * Reparto de un cobro mixto (ítem 6.9). `due` = total + propina + domicilio;
 * `creditCap` = total + domicilio (la propina no se fía).
 */
describe('splitPayment', () => {
  it('efectivo + tarjeta exactos: cada medio con lo suyo, sin vuelto', () => {
    const r = splitPayment(
      [
        { method: 'cash', amount: 20_000 },
        { method: 'card', amount: 39_000 },
      ],
      59_000,
      59_000,
    );
    expect(r.parts).toEqual([
      { method: 'cash', amount: 20_000 },
      { method: 'card', amount: 39_000 },
    ]);
    expect(r.change).toBe(0);
    expect(r.cashReceived).toBe(20_000);
    expect(r.primaryMethod).toBe('card');
  });

  it('el vuelto sale del efectivo: la parte guardada es neta', () => {
    const r = splitPayment(
      [
        { method: 'card', amount: 30_000 },
        { method: 'cash', amount: 50_000 },
      ],
      59_000,
      59_000,
    );
    expect(r.change).toBe(21_000);
    expect(r.cashReceived).toBe(50_000);
    expect(r.parts).toEqual([
      { method: 'card', amount: 30_000 },
      { method: 'cash', amount: 29_000 },
    ]);
    expect(r.parts.reduce((a, p) => a + p.amount, 0)).toBe(59_000);
  });

  it('suma insuficiente: rechaza diciendo cuánto falta', () => {
    expect(() =>
      splitPayment(
        [
          { method: 'cash', amount: 10_000 },
          { method: 'card', amount: 20_000 },
        ],
        59_000,
        59_000,
      ),
    ).toThrow(/faltan \$29000/);
  });

  it('vuelto con tarjeta: lo que no es efectivo no puede pasarse del total', () => {
    expect(() =>
      splitPayment(
        [
          { method: 'card', amount: 60_000 },
          { method: 'cash', amount: 5_000 },
        ],
        59_000,
        59_000,
      ),
    ).toThrow(SplitPaymentError);
  });

  it('dos partes del mismo medio se juntan', () => {
    const r = splitPayment(
      [
        { method: 'card', amount: 10_000 },
        { method: 'card', amount: 15_000 },
        { method: 'cash', amount: 5_000 },
      ],
      30_000,
      30_000,
    );
    expect(r.parts).toEqual([
      { method: 'card', amount: 25_000 },
      { method: 'cash', amount: 5_000 },
    ]);
  });

  it('el fiado es una parte, pero una sola', () => {
    const r = splitPayment(
      [
        { method: 'credit', amount: 40_000 },
        { method: 'cash', amount: 19_000 },
      ],
      59_000,
      54_000,
    );
    expect(r.creditAmount).toBe(40_000);
    expect(() =>
      splitPayment(
        [
          { method: 'credit', amount: 10_000 },
          { method: 'credit', amount: 10_000 },
          { method: 'cash', amount: 39_000 },
        ],
        59_000,
        54_000,
      ),
    ).toThrow(/una parte/);
  });

  it('la propina no se fía: la parte fiada no puede pasar de total + domicilio', () => {
    expect(() =>
      splitPayment(
        [
          { method: 'credit', amount: 55_000 },
          { method: 'cash', amount: 4_000 },
        ],
        59_000,
        54_000,
      ),
    ).toThrow(/propina no se fía/);
  });

  it('montos en cero o negativos no son una parte', () => {
    expect(() =>
      splitPayment([{ method: 'cash', amount: 0 }], 1_000, 1_000),
    ).toThrow(SplitPaymentError);
    expect(() => splitPayment([], 1_000, 1_000)).toThrow(SplitPaymentError);
  });

  it('pagó todo con tarjeta y además dio billetes: el efectivo era solo vuelto', () => {
    const r = splitPayment(
      [
        { method: 'card', amount: 59_000 },
        { method: 'cash', amount: 10_000 },
      ],
      59_000,
      59_000,
    );
    expect(r.parts).toEqual([{ method: 'card', amount: 59_000 }]);
    expect(r.change).toBe(10_000);
  });
});

describe('salePartsOf / cashAmountOf', () => {
  it('venta de un solo medio (o de antes del 6.9): su medio cubrió todo', () => {
    const v = { total: 50_000, tip: 5_000, deliveryFee: 4_000, payment: { method: 'cash' } };
    expect(salePartsOf(v)).toEqual([{ method: 'cash', amount: 59_000 }]);
    expect(cashAmountOf(v)).toBe(59_000);
    expect(cashAmountOf({ ...v, payment: { method: 'card' } })).toBe(0);
  });

  it('venta mixta: solo la parte en efectivo cuenta para el cajón', () => {
    const v = {
      total: 50_000,
      tip: 5_000,
      deliveryFee: 4_000,
      payment: { method: 'card' },
      payments: [
        { method: 'card', amount: 39_000 },
        { method: 'cash', amount: 20_000 },
      ],
    };
    expect(cashAmountOf(v)).toBe(20_000);
    expect(hasCreditPart(v)).toBe(false);
    expect(
      hasCreditPart({ ...v, payments: [...v.payments, { method: 'credit', amount: 1 }] }),
    ).toBe(true);
  });
});

describe('sourceId de tesorería', () => {
  it('un solo medio usa el id de la venta; el mixto, uno por medio', () => {
    expect(treasurySourceId('s1', 'card', false)).toBe('s1');
    expect(treasurySourceId('s1', 'card', true)).toBe('s1:card');
    expect(treasurySourceIds('s1')).toEqual(['s1', 's1:card', 's1:transfer']);
  });
});
