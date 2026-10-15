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

describe('devoluciones parciales sucesivas · ítem 1.11', () => {
  /**
   * Tres devoluciones de 1 sobre una línea de 3 que costó $10.000 (IVA 19 %).
   * Cada una a ojo sería 3.333,33: redondeando por separado se devolvían
   * 3.333 × 3 = 9.999 y el peso restante quedaba colgando para siempre.
   */
  const linea = { productId: 'x', qty: 3, taxBase: 8_403, taxAmount: 1_597 };

  function devolverEnTres() {
    const devuelto = new Map<string, number>();
    const reembolsado = new Map<string, { refund: number; refundTax: number }>();
    const planes = [1, 1, 1].map((qty) => {
      const plan = buildReturnPlan(
        [linea],
        [{ productId: 'x', qty }],
        devuelto,
        reembolsado,
      );
      const l = plan.lines[0]!;
      devuelto.set('x', (devuelto.get('x') ?? 0) + l.qty);
      const prev = reembolsado.get('x') ?? { refund: 0, refundTax: 0 };
      reembolsado.set('x', {
        refund: prev.refund + l.refund,
        refundTax: prev.refundTax + l.refundTax,
      });
      return plan;
    });
    return planes;
  }

  it('la suma de las devoluciones es exacto lo que se pagó por la línea', () => {
    const planes = devolverEnTres();
    expect(planes.reduce((s, p) => s + p.refundTotal, 0)).toBe(10_000);
    expect(planes.reduce((s, p) => s + p.refundTax, 0)).toBe(1_597);
    for (const p of planes) expect(Number.isInteger(p.refundTotal)).toBe(true);
  });

  it('sin el historial en pesos también cierra exacto (acumulado por cantidad)', () => {
    const devuelto = new Map<string, number>();
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const plan = buildReturnPlan([linea], [{ productId: 'x', qty: 1 }], devuelto);
      total += plan.refundTotal;
      devuelto.set('x', (devuelto.get('x') ?? 0) + 1);
    }
    expect(total).toBe(10_000);
  });

  it('la última devolución salda lo que falte aunque las previas se calcularan distinto', () => {
    // Una venta vieja: antes se devolvieron 2 por $6.666 en total.
    const plan = buildReturnPlan(
      [linea],
      [{ productId: 'x', qty: 1 }],
      new Map([['x', 2]]),
      new Map([['x', { refund: 6_666, refundTax: 1_064 }]]),
    );
    expect(plan.refundTotal).toBe(3_334);
    expect(plan.refundTax).toBe(533);
  });
});

describe('mismo producto en varias líneas de la venta', () => {
  /**
   * Tres renglones de gaseosa con descuentos distintos: 2 por $10.000, 1 por
   * $4.000 y 3 por $9.000. Antes la devolución se validaba y se pagaba solo
   * contra el ÚLTIMO renglón (3 unidades a $3.000): devolver 4 se rechazaba y
   * devolver 2 pagaba $6.000 en vez de la parte de lo pagado por las seis.
   */
  const vendidas = [
    { productId: 'gaseosa', qty: 2, taxBase: 8_403, taxAmount: 1_597 },
    { productId: 'gaseosa', qty: 1, taxBase: 3_361, taxAmount: 639 },
    { productId: 'gaseosa', qty: 3, taxBase: 7_563, taxAmount: 1_437 },
  ];
  const nada = new Map<string, number>();

  it('valida contra lo vendido en TODAS las líneas del producto', () => {
    const plan = buildReturnPlan(vendidas, [{ productId: 'gaseosa', qty: 4 }], nada);
    expect(plan.lines[0]!.qty).toBe(4);
    expect(() =>
      buildReturnPlan(vendidas, [{ productId: 'gaseosa', qty: 7 }], nada),
    ).toThrow(/solo se vendieron 6/i);
  });

  it('devolución parcial: la parte proporcional de lo pagado por las seis', () => {
    const plan = buildReturnPlan(vendidas, [{ productId: 'gaseosa', qty: 2 }], nada);
    // 23.000 × 2/6 = 7.666,67 → 7.667; IVA 3.673 × 2/6 = 1.224,33 → 1.224.
    expect(plan.refundTotal).toBe(7_667);
    expect(plan.refundTax).toBe(1_224);
  });

  it('devolución total de una vez: exacto lo pagado', () => {
    const plan = buildReturnPlan(vendidas, [{ productId: 'gaseosa', qty: 6 }], nada);
    expect(plan.refundTotal).toBe(23_000);
    expect(plan.refundTax).toBe(3_673);
  });

  it('parcial y luego el resto: la segunda salda exacto el saldo', () => {
    const primera = buildReturnPlan(vendidas, [{ productId: 'gaseosa', qty: 2 }], nada);
    const segunda = buildReturnPlan(
      vendidas,
      [{ productId: 'gaseosa', qty: 4 }],
      new Map([['gaseosa', 2]]),
      new Map([
        ['gaseosa', { refund: primera.refundTotal, refundTax: primera.refundTax }],
      ]),
    );
    expect(primera.refundTotal + segunda.refundTotal).toBe(23_000);
    expect(primera.refundTax + segunda.refundTax).toBe(3_673);
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
