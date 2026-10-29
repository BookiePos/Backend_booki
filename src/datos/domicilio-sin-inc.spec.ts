import { describe, it, expect } from 'vitest';
import { aplicarDomicilioSinInc, contarDomicilioSinInc } from './domicilio-sin-inc';

/**
 * Informe en seco del domicilio cobrado sin impuesto antes de oct-2026. El
 * libro no se reescribe: el contador decide con estas cifras.
 */
describe('informe de domicilio sin INC', () => {
  it('agrupa por mes de Colombia y salta lo que ya lleva la regla nueva', () => {
    const c = contarDomicilioSinInc([
      { deliveryFee: 5_000, createdAt: new Date('2026-09-10T15:00:00Z') },
      // 30-sep a las 9 p.m. en Bogotá es 1-oct en UTC: cuenta en septiembre.
      { deliveryFee: 3_000, createdAt: new Date('2026-10-01T02:00:00Z') },
      { deliveryFee: 4_000, createdAt: new Date('2026-10-05T15:00:00Z') },
      // Ya con impuesto del domicilio: no es parte del informe.
      { deliveryFee: 5_000, deliveryTaxKind: 'inc', createdAt: new Date('2026-10-29T15:00:00Z') },
      // Sin domicilio.
      { deliveryFee: 0, createdAt: new Date('2026-10-05T15:00:00Z') },
    ]);
    expect(c).toEqual({
      '2026-09.ventas': 2,
      '2026-09.domicilio': 8_000,
      // 5.000 → 370 y 3.000 → 222.
      '2026-09.inc8Incluido': 592,
      '2026-10.ventas': 1,
      '2026-10.domicilio': 4_000,
      '2026-10.inc8Incluido': 296,
    });
  });

  it('la venta offline cuenta en el mes en que se cobró', () => {
    const c = contarDomicilioSinInc([
      {
        deliveryFee: 5_000,
        soldAt: new Date('2026-08-31T15:00:00Z'),
        createdAt: new Date('2026-09-01T15:00:00Z'),
      },
    ]);
    expect(c['2026-08.ventas']).toBe(1);
  });

  it('no escribe nunca', async () => {
    await expect(aplicarDomicilioSinInc()).rejects.toThrow('Solo informe');
  });
});
