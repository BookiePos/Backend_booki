import { describe, expect, it } from 'vitest';
import { MEDIO_PAGO_BY_METHOD, pagoPosDian } from './einvoicing.constants';

describe('medio de pago del POS (Fase 7A)', () => {
  it('efectivo 10; tarjeta débito 49 y crédito 48 según cardType; transferencia 47', () => {
    expect(pagoPosDian({ method: 'cash' })).toEqual({ formaPago: '1', medio: '10' });
    expect(pagoPosDian({ method: 'card', cardType: 'debit' })).toEqual({ formaPago: '1', medio: '49' });
    expect(pagoPosDian({ method: 'card', cardType: 'credit' })).toEqual({ formaPago: '1', medio: '48' });
    expect(pagoPosDian({ method: 'transfer' })).toEqual({ formaPago: '1', medio: '47' });
  });

  it('Nequi, Daviplata y QR son transferencia: 47', () => {
    expect(pagoPosDian({ method: 'transfer', channel: 'nequi' }).medio).toBe('47');
    expect(pagoPosDian({ method: 'transfer', channel: 'qr' }).medio).toBe('47');
  });

  it('tarjeta sin tipo: 48, lo mismo que manda hoy la factura', () => {
    expect(pagoPosDian({ method: 'card' }).medio).toBe('48');
  });

  it('fiado: forma 2 (crédito), instrumento no definido; plataforma: acuerdo mutuo de contado', () => {
    expect(pagoPosDian({ method: 'credit' })).toEqual({ formaPago: '2', medio: '1' });
    expect(pagoPosDian({ method: 'platform' })).toEqual({ formaPago: '1', medio: 'ZZZ' });
  });

  it('un medio desconocido no se adivina como efectivo', () => {
    expect(pagoPosDian({ method: 'otro' })).toEqual({ formaPago: '1', medio: '1' });
  });

  it('la factura de venta no cambia de tabla', () => {
    expect(MEDIO_PAGO_BY_METHOD).toEqual({ cash: '10', card: '48', transfer: '42' });
  });
});
