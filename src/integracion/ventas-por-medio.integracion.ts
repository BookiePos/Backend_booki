import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BY_METHOD_PIPELINE } from '../modules/core-reports/application/by-method.pipeline';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * Reporte de ventas por medio de pago contra un Mongo real (ítem 6.9): un
 * cobro mixto aparece en cada medio que usó, con el ingreso prorrateado (la
 * suma por medios sigue siendo el ingreso total) y `collected` por medio.
 */
describe('reporte · ventas por medio de pago', () => {
  const EMPRESA = 'dddddddddddddddddddddddd';
  let env: Entorno;

  beforeAll(async () => {
    env = await levantarEntorno();
  });
  afterAll(async () => {
    await env?.cerrar();
  });

  it('prorratea el ingreso del mixto y suma lo cobrado por medio', async () => {
    const ventas = env.baseDe(EMPRESA).collection('ventas_por_medio');
    await ventas.insertMany([
      // Venta de un solo medio (sin `payments`): su medio cubrió todo.
      { total: 50_000, tip: 0, deliveryFee: 0, payment: { method: 'cash' } },
      // Mixto: $100.000 + propina $10.000 + domicilio $10.000 = $120.000,
      // con $30.000 en efectivo y $90.000 con tarjeta.
      {
        total: 100_000,
        tip: 10_000,
        deliveryFee: 10_000,
        payment: { method: 'card' },
        payments: [
          { method: 'cash', amount: 30_000 },
          { method: 'card', amount: 90_000 },
        ],
      },
      // Venta vieja sin propina ni domicilio guardados.
      { total: 20_000, payment: { method: 'transfer' } },
    ]);

    const filas = (await ventas.aggregate(BY_METHOD_PIPELINE).toArray()) as unknown as {
      _id: string;
      revenue: number;
      collected: number;
      tickets: number;
    }[];
    const por = Object.fromEntries(filas.map((f) => [f._id, f]));

    expect(por.cash).toMatchObject({ revenue: 50_000 + 25_000, collected: 80_000, tickets: 2 });
    expect(por.card).toMatchObject({ revenue: 75_000, collected: 90_000, tickets: 1 });
    expect(por.transfer).toMatchObject({ revenue: 20_000, collected: 20_000, tickets: 1 });
    // La suma por medios es el ingreso total.
    expect(filas.reduce((a, f) => a + f.revenue, 0)).toBe(170_000);
  });
});
