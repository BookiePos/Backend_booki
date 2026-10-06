import { describe, it, expect } from 'vitest';
import { splitDeliveryTax } from './delivery-tax';

/**
 * El domicilio hace parte de la base gravable (DIAN, Oficio 664 de 2022) y
 * sigue la tarifa de lo que se lleva. Lo que no puede pasar: que las porciones
 * no sumen lo que pagó el cliente, o que una tarifa se quede con impuesto de
 * otra.
 */
describe('splitDeliveryTax', () => {
  const suma = (parts: { gross: number }[]) =>
    Math.round(parts.reduce((a, p) => a + p.gross, 0) * 100) / 100;

  it('una sola tarifa: el domicilio entero lleva ese impuesto', () => {
    const parts = splitDeliveryTax(5_950, [{ net: 11_900, rate: 19 }]);

    expect(parts).toEqual([{ rate: 19, gross: 5_950, base: 5_000, amount: 950 }]);
  });

  it('el valor del domicilio YA incluye el impuesto: base + impuesto = cobro', () => {
    const [p] = splitDeliveryTax(5_000, [{ net: 11_900, rate: 19 }]);

    expect(Math.round(((p?.base ?? 0) + (p?.amount ?? 0)) * 100) / 100).toBe(5_000);
  });

  it('tarifas mezcladas: se reparte por el valor neto de cada una', () => {
    // 30.000 al 19 % y 10.000 excluido → 75 % y 25 % del domicilio.
    const parts = splitDeliveryTax(4_000, [
      { net: 30_000, rate: 19 },
      { net: 10_000, rate: 0 },
    ]);

    expect(parts.map((p) => [p.rate, p.gross])).toEqual([
      [19, 3_000],
      [0, 1_000],
    ]);
    // Lo excluido no genera impuesto.
    expect(parts[1]).toMatchObject({ base: 1_000, amount: 0 });
  });

  it('agrupa las líneas de la misma tarifa en una sola porción', () => {
    const parts = splitDeliveryTax(6_000, [
      { net: 10_000, rate: 19 },
      { net: 10_000, rate: 19 },
      { net: 10_000, rate: 5 },
    ]);

    expect(parts.map((p) => p.rate)).toEqual([19, 5]);
    expect(parts.map((p) => p.gross)).toEqual([4_000, 2_000]);
  });

  it('las porciones suman exactamente el cobro, aunque el reparto no sea exacto', () => {
    const parts = splitDeliveryTax(5_000, [
      { net: 1, rate: 19 },
      { net: 1, rate: 5 },
      { net: 1, rate: 0 },
    ]);

    expect(suma(parts)).toBe(5_000);
  });

  it('sin domicilio no hay nada que repartir', () => {
    expect(splitDeliveryTax(0, [{ net: 10_000, rate: 19 }])).toEqual([]);
  });

  it('venta sin valor neto: va completo a la tarifa más alta presente', () => {
    const parts = splitDeliveryTax(3_000, [
      { net: 0, rate: 5 },
      { net: 0, rate: 19 },
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ rate: 19, gross: 3_000 });
  });

  it('sin líneas: el domicilio queda sin impuesto', () => {
    expect(splitDeliveryTax(3_000, [])).toEqual([
      { rate: 0, gross: 3_000, base: 3_000, amount: 0 },
    ]);
  });
});
