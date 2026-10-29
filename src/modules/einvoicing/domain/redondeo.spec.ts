import { describe, expect, it } from 'vitest';
import {
  aCentavos,
  assertCuadre,
  centavosDeCop,
  descuadres,
  desglosarPrecioConImpuesto,
  formatearMontoDian,
  impuestoDeBase,
  redondearLinea,
  totalesDesdeLineas,
} from './redondeo';

describe('formatearMontoDian (el único que arma el texto 0.00)', () => {
  it('punto decimal, dos decimales, sin separadores', () => {
    expect(formatearMontoDian(178500000)).toBe('1785000.00');
    expect(formatearMontoDian(26256)).toBe('262.56');
    expect(formatearMontoDian(828)).toBe('8.28');
    expect(formatearMontoDian(5)).toBe('0.05');
    expect(formatearMontoDian(0)).toBe('0.00');
  });

  it('rechaza lo que no son centavos enteros no negativos', () => {
    expect(() => formatearMontoDian(1.5)).toThrow(/centavos enteros/);
    expect(() => formatearMontoDian(-100)).toThrow(/centavos enteros/);
    expect(() => formatearMontoDian(Number.NaN)).toThrow();
  });
});

describe('conversión a centavos', () => {
  it('desde caja pasa por cop(): pesos enteros', () => {
    expect(centavosDeCop(119000)).toBe(11900000);
    expect(centavosDeCop(1999.6)).toBe(200000);
  });

  it('redondea a la mitad hacia arriba sin el ruido del flotante', () => {
    expect(aCentavos(1.005)).toBe(101);
    expect(aCentavos(0.1 + 0.2)).toBe(30);
    expect(aCentavos(235.28)).toBe(23528);
    expect(aCentavos(84033.6134)).toBe(8403361);
  });

  it('impuesto de una base a su tarifa', () => {
    expect(impuestoDeBase(10000000, 19)).toBe(1900000);
    expect(impuestoDeBase(10000000, 8)).toBe(800000);
    expect(impuestoDeBase(333, 19)).toBe(63);
    expect(impuestoDeBase(10000000, 0)).toBe(0);
    expect(() => impuestoDeBase(100, -1)).toThrow(/Tarifa/);
  });

  it('desglose de un precio con impuesto incluido: base + impuesto = precio exacto', () => {
    // 10.000 con INC 8 %: 9.259,26 + 740,74.
    expect(desglosarPrecioConImpuesto(10000, 8)).toEqual({ base: 925926, impuesto: 74074 });
    // 11.900 con IVA 19 %: exacto.
    expect(desglosarPrecioConImpuesto(11900, 19)).toEqual({ base: 1000000, impuesto: 190000 });
    for (const precio of [1, 999, 4500, 12345, 87990]) {
      for (const tarifa of [0, 5, 8, 19]) {
        const { base, impuesto } = desglosarPrecioConImpuesto(precio, tarifa);
        expect(base + impuesto).toBe(precio * 100);
      }
    }
    expect(() => desglosarPrecioConImpuesto(100, Number.NaN)).toThrow(/Tarifa/);
  });
});

describe('líneas y totales', () => {
  it('cada línea se redondea una vez; el exento lleva los impuestos en 0', () => {
    expect(redondearLinea({ base: 9259.259, impuestos: { '04': 740.7407 } })).toEqual({
      base: 925926,
      impuestos: { '01': 0, '04': 74074, '03': 0 },
      total: 1000000,
    });
    expect(redondearLinea({ base: 5000 })).toEqual({
      base: 500000,
      impuestos: { '01': 0, '04': 0, '03': 0 },
      total: 500000,
    });
    expect(() => redondearLinea({ base: -1 })).toThrow(/Base/);
    expect(() => redondearLinea({ base: 1, impuestos: { '01': -1 } })).toThrow(/Impuesto 01/);
  });

  it('los totales son la suma de las líneas (IVA + INC en el mismo documento)', () => {
    const lineas = [
      redondearLinea({ base: 10000, impuestos: { '01': 1900 } }),
      redondearLinea({ base: 9259.26, impuestos: { '04': 740.74 } }),
      redondearLinea({ base: 3000 }),
    ];
    const t = totalesDesdeLineas(lineas);
    expect(t).toEqual({
      valorBruto: 2225926,
      impuestos: { '01': 190000, '04': 74074, '03': 0 },
      valorTotal: 2490000,
    });
    expect(descuadres(lineas, t)).toEqual([]);
    expect(() => assertCuadre(lineas, t)).not.toThrow();
  });

  it('documento vacío: todo en cero y cuadra', () => {
    const t = totalesDesdeLineas([]);
    expect(t.valorTotal).toBe(0);
    expect(descuadres([], t)).toEqual([]);
  });

  it('tolerancia 0: un centavo de diferencia es un descuadre', () => {
    const lineas = [redondearLinea({ base: 100, impuestos: { '01': 19 } })];
    const t = totalesDesdeLineas(lineas);
    const malo = { ...t, impuestos: { ...t.impuestos, '01': t.impuestos['01'] + 1 } };
    expect(descuadres(lineas, malo)).toEqual([
      'Impuesto 01: 19.01 ≠ suma de líneas 19.00',
      'Valor total 119.00 ≠ bruto + impuestos 119.01',
    ]);
    expect(() => assertCuadre(lineas, malo)).toThrow(/no cuadra/);
    expect(descuadres(lineas, { ...t, valorBruto: 1, valorTotal: 1 })).toHaveLength(3);
  });
});
