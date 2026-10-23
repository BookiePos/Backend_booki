import { describe, expect, it } from 'vitest';
import {
  formatOfflineNumber,
  offlineCounterId,
  offlineSaleViolations,
  parseOfflineNumber,
  soldAtIsPlausible,
} from './offline-sales';

describe('offline-sales · consecutivos de contingencia', () => {
  it('formatea y lee la serie FVC sin confundirla con la FV', () => {
    expect(formatOfflineNumber(7)).toBe('FVC-000007');
    expect(parseOfflineNumber('FVC-000007')).toBe(7);
    expect(parseOfflineNumber('FVC-1234567')).toBe(1_234_567);
    expect(parseOfflineNumber('FV-000007')).toBeNull();
    expect(parseOfflineNumber('FVC-000000')).toBeNull();
    expect(parseOfflineNumber('FVC-12')).toBeNull();
    expect(offlineCounterId('s1')).toBe('sale-offline:s1');
  });
});

describe('offline-sales · qué se puede cobrar sin red', () => {
  const efectivo = {
    lines: [{}],
    payment: { method: 'cash', received: 20_000 },
    orderType: 'mostrador',
  };

  it('efectivo en mostrador pasa', () => {
    expect(offlineSaleViolations(efectivo)).toEqual([]);
  });

  it.each([
    ['tarjeta', { payment: { method: 'card' } }],
    ['fiado', { payment: { method: 'credit' } }],
    ['mixto', { payments: [], payment: undefined }],
    ['descuento de venta', { discount: { type: 'amount', value: 1 } }],
    ['descuento de línea', { lines: [{ discountId: 'd1' }] }],
    ['lista de precios', { priceListId: 'p1' }],
    ['cliente registrado', { customerId: 'c1' }],
    ['domicilio', { orderType: 'domicilio' }],
  ])('rechaza %s', (_n, cambio) => {
    expect(offlineSaleViolations({ ...efectivo, ...cambio }).length).toBeGreaterThan(0);
  });
});

describe('offline-sales · fecha creíble', () => {
  const reservada = new Date('2026-10-22T10:00:00Z');
  const ahora = new Date('2026-10-22T15:00:00Z');
  it('acepta entre la reserva y ahora, con holgura de reloj', () => {
    expect(soldAtIsPlausible(new Date('2026-10-22T12:00:00Z'), reservada, ahora)).toBe(true);
    expect(soldAtIsPlausible(new Date('2026-10-22T09:57:00Z'), reservada, ahora)).toBe(true);
  });
  it('rechaza antes de la reserva, en el futuro o inválida', () => {
    expect(soldAtIsPlausible(new Date('2026-10-22T09:00:00Z'), reservada, ahora)).toBe(false);
    expect(soldAtIsPlausible(new Date('2026-10-22T16:00:00Z'), reservada, ahora)).toBe(false);
    expect(soldAtIsPlausible(new Date('x'), reservada, ahora)).toBe(false);
  });
});
