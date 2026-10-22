import { describe, it, expect } from 'vitest';
import {
  indexProducts,
  matchProduct,
  parseAmountCop,
  parseCsv,
  parsePlatformCsv,
  validateSettlement,
  fechaContablePedido,
} from './platform-orders';

describe('parseCsv', () => {
  it('lee ; con comillas, BOM y saltos CRLF', () => {
    const rows = parseCsv('﻿a;b\r\n"x;1";"di ""hola"""\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x;1', 'di "hola"'],
    ]);
  });
});

describe('parseAmountCop', () => {
  it.each([
    ['$ 12.500', 12_500],
    ['12,500.00', 12_500],
    ['12.500,50', 12_501],
    ['1.234.567', 1_234_567],
    ['3500', 3_500],
    ['', undefined],
    ['n/a', undefined],
  ])('%s → %s', (raw, esperado) => {
    expect(parseAmountCop(raw)).toBe(esperado);
  });
});

describe('parsePlatformCsv', () => {
  const csv = [
    'Pedido;Fecha;Producto;SKU;Cantidad;Comisión;Total',
    'R-1;05/10/2026;Hamburguesa Clásica;HAM-1;2;$ 4.000;$ 40.000',
    'R-1;05/10/2026;Gaseosa;;1;;',
    'R-2;2026-10-06;Papas;PAP-1;1;1.500;12.000',
    ';05/10/2026;Algo;X;1;;',
    'R-3;05/10/2026;Malo;M-1;cero;;',
  ].join('\n');

  it('agrupa por pedido y reporta errores por fila sin detener el resto', () => {
    const r = parsePlatformCsv(csv);
    expect(r.orders.map((o) => o.externalId)).toEqual(['R-1', 'R-2']);
    const r1 = r.orders[0]!;
    expect(r1.lines).toHaveLength(2);
    expect(r1.orderedAt).toBe('2026-10-05');
    expect(r1.commission).toBe(4_000);
    expect(r1.reportedTotal).toBe(40_000);
    expect(r.errors.map((e) => e.line)).toEqual([5, 6]);
    expect(r.errors[0]!.message).toMatch(/código del pedido/);
    expect(r.errors[1]!.message).toMatch(/Cantidad inválida/);
  });

  it('sin columnas obligatorias da un error de encabezado', () => {
    const r = parsePlatformCsv('Fecha;Total\n2026-10-01;1000');
    expect(r.orders).toEqual([]);
    expect(r.errors[0]!.message).toMatch(/Faltan columnas/);
  });

  it('acepta encabezados en inglés y con tildes', () => {
    const r = parsePlatformCsv('order_id,item,quantity\nU-9,Café,2');
    expect(r.orders[0]!.lines[0]).toMatchObject({ name: 'Café', qty: 2 });
  });
});

describe('matchProduct', () => {
  const idx = indexProducts([
    { id: 'a', sku: 'HAM-1', name: 'Hamburguesa Clásica' },
    { id: 'b', sku: 'CAF-1', name: 'Café' },
    { id: 'c', sku: 'CAF-2', name: 'cafe' },
  ]);

  it('empareja por SKU sin importar mayúsculas', () => {
    expect(matchProduct({ sku: 'ham-1' }, idx)).toMatchObject({ ok: true, productId: 'a' });
  });
  it('empareja por nombre sin tildes ni mayúsculas', () => {
    expect(matchProduct({ name: 'HAMBURGUESA  clasica' }, idx)).toMatchObject({ ok: true, productId: 'a' });
  });
  it('no adivina entre dos nombres iguales', () => {
    const r = matchProduct({ name: 'Café' }, idx);
    expect(r.ok).toBe(false);
  });
  it('producto desconocido es error', () => {
    expect(matchProduct({ name: 'Pizza' }, idx).ok).toBe(false);
  });
});

describe('validateSettlement', () => {
  const z = { retefuente: 0, reteIca: 0, reteIva: 0, ajustePrecio: 0 };
  it('cuadra cuando consignado + comisión + IVA + retenciones = bruto + ajuste', () => {
    expect(
      validateSettlement({ ...z, gross: 100_000, received: 70_000, commission: 25_210, commissionIva: 4_790 }),
    ).toBeNull();
    expect(
      validateSettlement({
        gross: 100_000, received: 61_000, commission: 25_000, commissionIva: 4_750,
        retefuente: 2_000, reteIca: 250, reteIva: 1_000, ajustePrecio: -6_000,
      }),
    ).toBeNull();
    // La plataforma cobró 5.000 de más: entra al bruto a repartir.
    expect(
      validateSettlement({ ...z, gross: 100_000, received: 80_000, commission: 25_000, commissionIva: 0, ajustePrecio: 5_000 }),
    ).toBeNull();
    expect(
      validateSettlement({ ...z, gross: 100_000, received: 70_000, commission: 25_000, commissionIva: 0, ajustePrecio: -5_000 }),
    ).toBeNull();
  });
  it('rechaza la diferencia, falte o sobre', () => {
    expect(validateSettlement({ ...z, gross: 100_000, received: 70_000, commission: 20_000, commissionIva: 0 })).toMatch(/faltan \$10000/);
    expect(validateSettlement({ ...z, gross: 100_000, received: 90_000, commission: 20_000, commissionIva: 0 })).toMatch(/sobran \$10000/);
  });
  it('rechaza fracciones y negativos (el ajuste sí puede ser negativo, pero entero)', () => {
    expect(validateSettlement({ ...z, gross: 100_000, received: 99_999.5, commission: 0.5, commissionIva: 0 })).not.toBeNull();
    expect(validateSettlement({ ...z, gross: 100_000, received: 110_000, commission: -10_000, commissionIva: 0 })).not.toBeNull();
    expect(validateSettlement({ ...z, retefuente: -1, gross: 100_000, received: 100_001, commission: 0, commissionIva: 0 })).not.toBeNull();
    expect(validateSettlement({ ...z, gross: 100_000, received: 100_000, commission: 0, commissionIva: 0, ajustePrecio: 0.5 })).not.toBeNull();
  });
});

describe('fechaContablePedido', () => {
  it('usa la fecha del pedido si cae en el mes en curso; si es de un mes anterior, hoy', () => {
    expect(fechaContablePedido('2026-10-03', '2026-10-22')).toEqual({ fecha: '2026-10-03' });
    expect(fechaContablePedido('2026-09-30', '2026-10-22')).toEqual({ fecha: '2026-10-22' });
    expect(fechaContablePedido(undefined, '2026-10-22')).toEqual({ fecha: '2026-10-22' });
  });
  it('rechaza una fecha futura', () => {
    expect(fechaContablePedido('2026-10-23', '2026-10-22')).toHaveProperty('error');
  });
});
