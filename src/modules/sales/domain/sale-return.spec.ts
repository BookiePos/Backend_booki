import { describe, it, expect } from 'vitest';
import { buildReturnPlan, prorateLots, refundForLine } from './sale-return';

/**
 * Devolución parcial: cuánta plata sale.
 *
 * Es dinero que se entrega en el mostrador, sin que nadie lo revise después.
 * Las dos equivocaciones tienen consecuencias opuestas y las dos son caras:
 *
 * 1. Devolver de MÁS. Si se devuelve el precio de lista y la venta llevaba
 *    descuento, se está regalando el descuento por segunda vez. Y si no se
 *    controla lo ya devuelto, el mismo cliente puede devolver lo mismo dos
 *    veces y salir con más plata de la que puso.
 * 2. Devolver de MENOS. Eso es una discusión en la caja, y el cliente tiene
 *    razón.
 *
 * Por eso el reembolso sale de `taxBase + taxAmount` —lo que el cliente PAGÓ
 * por esa línea, ya neto de todos los descuentos— y no de `unitPrice × qty`.
 */
describe('refundForLine · lo que se le devuelve al cliente', () => {
  it('devuelve la parte proporcional de lo que pagó', () => {
    // Diez unidades que costaron $100.000 con IVA; vuelven dos.
    const linea = {
      productId: 'p1',
      qty: 10,
      taxBase: 84_034,
      taxAmount: 15_966,
    };
    const r = refundForLine(linea, 2);
    expect(r.refund).toBe(20_000);
    expect(r.refundTax).toBe(3_193);
  });

  it('devuelve el precio PAGADO, no el de lista: el descuento no se regala dos veces', () => {
    // Se vendieron 10 a $3.000 ($30.000) con 20 % de descuento: pagó $24.000.
    // Devolviendo 2, le corresponden $4.800 y no $6.000.
    const conDescuento = {
      productId: 'p1',
      qty: 10,
      taxBase: 20_168,
      taxAmount: 3_832,
    };
    expect(refundForLine(conDescuento, 2).refund).toBe(4_800);
  });

  it('devolver todo devuelve todo lo pagado, sin sobrante ni faltante', () => {
    const linea = { productId: 'p1', qty: 4, taxBase: 10_084, taxAmount: 1_916 };
    expect(refundForLine(linea, 4).refund).toBe(12_000);
  });

  it('un producto sin IVA no inventa impuesto que reversar', () => {
    const excluido = { productId: 'p1', qty: 5, taxBase: 50_000, taxAmount: 0 };
    const r = refundForLine(excluido, 2);
    expect(r.refund).toBe(20_000);
    expect(r.refundTax).toBe(0);
  });
});

describe('buildReturnPlan · qué se puede devolver', () => {
  const vendidas = [
    { productId: 'gaseosa', qty: 10, taxBase: 21_008, taxAmount: 3_992 },
    { productId: 'pan', qty: 4, taxBase: 8_000, taxAmount: 0 },
  ];
  const nada = new Map<string, number>();

  it('suma el reembolso de varias líneas', () => {
    const plan = buildReturnPlan(
      vendidas,
      [
        { productId: 'gaseosa', qty: 2 },
        { productId: 'pan', qty: 1 },
      ],
      nada,
    );
    expect(plan.lines).toHaveLength(2);
    expect(plan.refundTotal).toBe(5_000 + 2_000);
  });

  it('el total es la suma de las líneas ya redondeadas', () => {
    // Importa que cuadre exactamente: es lo que alguien va a contar al cerrar
    // la caja, contra lo que dice el registro línea por línea.
    const plan = buildReturnPlan(
      [{ productId: 'x', qty: 3, taxBase: 8_403, taxAmount: 1_597 }],
      [{ productId: 'x', qty: 1 }],
      nada,
    );
    expect(plan.refundTotal).toBe(plan.lines.reduce((s, l) => s + l.refund, 0));
  });

  it('no deja devolver más de lo que se vendió', () => {
    expect(() =>
      buildReturnPlan(vendidas, [{ productId: 'pan', qty: 5 }], nada),
    ).toThrow(/solo se vendieron 4/i);
  });

  it('cuenta lo ya devuelto antes: no se puede devolver lo mismo dos veces', () => {
    // Lo peor que podría pasar aquí: que cada devolución pase la validación por
    // separado y el cliente salga con más plata de la que puso.
    const yaDevuelto = new Map([['gaseosa', 8]]);
    expect(() =>
      buildReturnPlan(vendidas, [{ productId: 'gaseosa', qty: 3 }], yaDevuelto),
    ).toThrow(/ya se devolvieron 8 de 10: quedan 2/i);
  });

  it('deja devolver justo lo que queda', () => {
    const yaDevuelto = new Map([['gaseosa', 8]]);
    const plan = buildReturnPlan(
      vendidas,
      [{ productId: 'gaseosa', qty: 2 }],
      yaDevuelto,
    );
    expect(plan.lines[0]!.qty).toBe(2);
  });

  it('rechaza un producto que no estaba en la venta', () => {
    expect(() =>
      buildReturnPlan(vendidas, [{ productId: 'leche', qty: 1 }], nada),
    ).toThrow(/no estaba en la venta/i);
  });

  it('rechaza cantidades en cero o negativas', () => {
    expect(() =>
      buildReturnPlan(vendidas, [{ productId: 'pan', qty: 0 }], nada),
    ).toThrow(/mayor que cero/i);
    expect(() =>
      buildReturnPlan(vendidas, [{ productId: 'pan', qty: -2 }], nada),
    ).toThrow(/mayor que cero/i);
  });

  it('rechaza una devolución vacía', () => {
    expect(() => buildReturnPlan(vendidas, [], nada)).toThrow(/nada que devolver/i);
  });

  it('suma las líneas repetidas del mismo producto antes de validar', () => {
    // Dos renglones de "pan 3" son 6, y solo se vendieron 4. Validar cada
    // renglón por separado dejaría pasar la devolución entera.
    expect(() =>
      buildReturnPlan(
        vendidas,
        [
          { productId: 'pan', qty: 3 },
          { productId: 'pan', qty: 3 },
        ],
        nada,
      ),
    ).toThrow(/solo se vendieron 4/i);
  });
});

describe('prorateLots · a qué lote vuelve la mercancía', () => {
  it('reparte lo devuelto entre los lotes de los que salió', () => {
    // Si volviera todo a un solo lote, el costo de los otros quedaría inflado
    // y el margen de las ventas siguientes saldría mal.
    const lotes = [
      { lotId: 'L1', qty: 300, unitCost: 10 },
      { lotId: 'L2', qty: 200, unitCost: 12 },
    ];
    const vuelta = prorateLots(lotes, 500, 100);
    expect(vuelta).toEqual([
      { lotId: 'L1', qty: 60, unitCost: 10 },
      { lotId: 'L2', qty: 40, unitCost: 12 },
    ]);
  });

  it('devolver todo devuelve cada lote completo', () => {
    const lotes = [{ lotId: 'L1', qty: 50, unitCost: 10 }];
    expect(prorateLots(lotes, 50, 50)).toEqual([
      { lotId: 'L1', qty: 50, unitCost: 10 },
    ]);
  });

  it('nunca devuelve más de lo que salió, aunque le pidan de más', () => {
    const lotes = [{ lotId: 'L1', qty: 50, unitCost: 10 }];
    expect(prorateLots(lotes, 50, 80)[0]!.qty).toBe(50);
  });

  it('un producto sin lotes no inventa ninguno', () => {
    expect(prorateLots([], 10, 2)).toEqual([]);
  });
});
