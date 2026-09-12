import { describe, it, expect } from 'vitest';
import {
  evenShare,
  isFullyPaid,
  planPayment,
  remainingOf,
} from './split-bill';

/**
 * Dividir la cuenta de una mesa.
 *
 * Lo que se juega es comida que sale del inventario sin que nadie la pague, o
 * cobrada dos veces. Ninguna de las dos avisa:
 *
 * - Si un cobro parcial no descuenta lo ya pagado, el mismo plato se cobra dos
 *   veces y el cliente lo nota en la caja, con la mesa mirando.
 * - Si al dividir entre tres lo que no se pudo repartir exacto se pierde, la
 *   comanda no cierra nunca y queda un pedazo colgando que nadie paga. Por eso
 *   el último cobro va SIN líneas y se lleva todo lo que falte.
 */
describe('planPayment · qué se cobra ahora', () => {
  const mesa = [
    { productId: 'pizza', qty: 1, paidQty: 0 },
    { productId: 'cerveza', qty: 4, paidQty: 0 },
  ];

  it('sin subconjunto se cobra la cuenta entera, como siempre', () => {
    const plan = planPayment(mesa);
    expect(plan.lines).toEqual([
      { productId: 'pizza', qty: 1 },
      { productId: 'cerveza', qty: 4 },
    ]);
    expect(plan.fullyPaid).toBe(true);
  });

  it('"yo pago la pizza y dos cervezas" deja la cuenta abierta con el resto', () => {
    const plan = planPayment(mesa, [
      { productId: 'pizza', qty: 1 },
      { productId: 'cerveza', qty: 2 },
    ]);
    expect(plan.fullyPaid).toBe(false);
    expect(plan.paidAfter).toEqual([1, 2]);
  });

  it('el siguiente cobro solo ve lo que falta', () => {
    const despues = [
      { productId: 'pizza', qty: 1, paidQty: 1 },
      { productId: 'cerveza', qty: 4, paidQty: 2 },
    ];
    expect(remainingOf(despues).get('pizza')).toBe(0);
    const plan = planPayment(despues);
    expect(plan.lines).toEqual([{ productId: 'cerveza', qty: 2 }]);
    expect(plan.fullyPaid).toBe(true);
  });

  it('no deja cobrar dos veces lo mismo', () => {
    // Es lo que el cliente nota en la caja, con la mesa mirando. La cuenta
    // sigue abierta por las cervezas, así que el aviso tiene que ser sobre la
    // pizza y no sobre la cuenta entera.
    const despues = [
      { productId: 'pizza', qty: 1, paidQty: 1 },
      { productId: 'cerveza', qty: 4, paidQty: 0 },
    ];
    expect(() =>
      planPayment(despues, [{ productId: 'pizza', qty: 1 }]),
    ).toThrow(/ya se pagó todo/i);
  });

  it('no deja cobrar más de lo que se pidió', () => {
    expect(() =>
      planPayment(mesa, [{ productId: 'cerveza', qty: 6 }]),
    ).toThrow(/solo quedan 4/i);
  });

  it('rechaza un producto que no está en la cuenta', () => {
    expect(() =>
      planPayment(mesa, [{ productId: 'whisky', qty: 1 }]),
    ).toThrow(/no está en la cuenta/i);
  });

  it('una cuenta ya saldada no se puede volver a cobrar', () => {
    const saldada = [{ productId: 'pizza', qty: 1, paidQty: 1 }];
    expect(isFullyPaid(saldada)).toBe(true);
    expect(() => planPayment(saldada)).toThrow(/ya está pagada completa/i);
  });

  it('reparte lo cobrado llenando un renglón antes que el otro', () => {
    // La mesa pidió otra ronda: el mismo producto en dos renglones. Cobrar
    // tres cervezas tiene que llenar el primero y desbordar al segundo, no
    // repartirse a medias entre los dos.
    const dosRondas = [
      { productId: 'cerveza', qty: 2, paidQty: 0 },
      { productId: 'cerveza', qty: 3, paidQty: 0 },
    ];
    const plan = planPayment(dosRondas, [{ productId: 'cerveza', qty: 3 }]);
    expect(plan.paidAfter).toEqual([2, 1]);
    expect(plan.fullyPaid).toBe(false);
  });

  it('rechaza cantidades en cero o negativas', () => {
    expect(() =>
      planPayment(mesa, [{ productId: 'pizza', qty: 0 }]),
    ).toThrow(/mayor que cero/i);
  });
});

describe('evenShare · partes iguales', () => {
  const mesa = [
    { productId: 'pizza', qty: 1, paidQty: 0 },
    { productId: 'cerveza', qty: 4, paidQty: 0 },
  ];

  it('cada parte se lleva su fracción de todo lo que hay', () => {
    const parte = evenShare(mesa, 4, 0);
    expect(parte).toEqual([
      { productId: 'pizza', qty: 0.25 },
      { productId: 'cerveza', qty: 1 },
    ]);
  });

  it('la última parte va VACÍA: se lleva todo lo que falte', () => {
    // Es lo que hace que diez unidades entre tres cuadren exactamente. Si la
    // última también se calculara, sobraría un pedazo que nadie paga y la
    // comanda no cerraría nunca.
    expect(evenShare(mesa, 4, 3)).toEqual([]);
  });

  it('lo que no se reparte exacto lo absorbe quien paga de último', () => {
    const diez = [{ productId: 'empanada', qty: 10, paidQty: 0 }];
    const primera = evenShare(diez, 3, 0);
    const segunda = evenShare(diez, 3, 1);
    expect(primera[0]!.qty).toBe(3.333);
    expect(segunda[0]!.qty).toBe(3.333);
    // La tercera va vacía y se lleva las 3,334 que quedan.
    expect(evenShare(diez, 3, 2)).toEqual([]);
  });

  it('reparte sobre lo que QUEDA, no sobre el total', () => {
    // Ya pagaron la pizza; dividir "entre dos" lo que falta son dos cervezas
    // para el primero, no una.
    const aMedias = [
      { productId: 'pizza', qty: 1, paidQty: 1 },
      { productId: 'cerveza', qty: 4, paidQty: 0 },
    ];
    expect(evenShare(aMedias, 2, 0)).toEqual([
      { productId: 'cerveza', qty: 2 },
    ]);
  });

  it('dividir en una sola parte no es dividir: va todo junto', () => {
    expect(evenShare(mesa, 1, 0)).toEqual([]);
  });
});
