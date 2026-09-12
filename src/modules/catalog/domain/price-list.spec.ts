import { describe, it, expect } from 'vitest';
import { pickTier, resolveUnitPrice } from './price-list';

/**
 * Listas de precios: mayorista, detal, distribuidor.
 *
 * Lo que se juega aquí es plata cobrada de menos, en silencio y en cada venta.
 * Una regla mal resuelta no produce ningún error: produce una tirilla con un
 * precio que nadie revisa hasta que cuadran el mes.
 *
 * Las dos equivocaciones caras tienen nombre:
 *
 * 1. Que la lista aplique cuando NO debía. El cliente de mostrador pagando
 *    precio de mayorista es margen regalado en cada venta del día.
 * 2. Que el escalón por cantidad se elija mal. Comprando 60 hay que cobrar el
 *    precio de 50, no el de 12 — y menos el de mostrador.
 */
describe('resolveUnitPrice · qué precio se cobra', () => {
  const gaseosa = 'p-gaseosa';

  it('sin lista se cobra el precio de mostrador: la venta normal no cambia', () => {
    expect(
      resolveUnitPrice({
        basePrice: 3_000,
        qty: 1,
        catalogProductId: gaseosa,
        list: null,
      }),
    ).toBe(3_000);
  });

  it('el porcentaje general baja todo el catálogo con una sola cifra', () => {
    // Es lo que permite arrancar el mismo día sin teclear trescientos precios.
    expect(
      resolveUnitPrice({
        basePrice: 3_000,
        qty: 1,
        catalogProductId: gaseosa,
        list: { discountPercent: 12, items: [] },
      }),
    ).toBe(2_640);
  });

  it('un precio pactado manda sobre el porcentaje general', () => {
    expect(
      resolveUnitPrice({
        basePrice: 3_000,
        qty: 1,
        catalogProductId: gaseosa,
        list: {
          discountPercent: 12,
          items: [{ catalogProductId: gaseosa, price: 2_500 }],
        },
      }),
    ).toBe(2_500);
  });

  it('el precio pactado de OTRO producto no se contagia', () => {
    expect(
      resolveUnitPrice({
        basePrice: 8_000,
        qty: 1,
        catalogProductId: 'p-pan',
        list: {
          discountPercent: 10,
          items: [{ catalogProductId: gaseosa, price: 2_500 }],
        },
      }),
    ).toBe(7_200); // le toca el porcentaje general, no los $2.500
  });

  it('por debajo de la cantidad mínima NO se da el precio por cantidad', () => {
    // Llevando 5 gaseosas se paga mostrador, no el precio de la docena. Que
    // esto falle es regalar el precio de mayorista en la venta de a una.
    expect(
      resolveUnitPrice({
        basePrice: 3_000,
        qty: 5,
        catalogProductId: gaseosa,
        list: {
          items: [{ catalogProductId: gaseosa, price: 2_500, minQty: 12 }],
        },
      }),
    ).toBe(3_000);
  });

  it('alcanzada la cantidad mínima, se cobra el precio pactado', () => {
    expect(
      resolveUnitPrice({
        basePrice: 3_000,
        qty: 12,
        catalogProductId: gaseosa,
        list: {
          items: [{ catalogProductId: gaseosa, price: 2_500, minQty: 12 }],
        },
      }),
    ).toBe(2_500);
  });

  it('con escalones, gana el mayor que la cantidad alcanza', () => {
    // Comprando 60 se paga el precio de 50, no el de 12.
    const list = {
      items: [
        { catalogProductId: gaseosa, price: 2_500, minQty: 12 },
        { catalogProductId: gaseosa, price: 2_200, minQty: 50 },
      ],
    };
    expect(
      resolveUnitPrice({ basePrice: 3_000, qty: 60, catalogProductId: gaseosa, list }),
    ).toBe(2_200);
    expect(
      resolveUnitPrice({ basePrice: 3_000, qty: 20, catalogProductId: gaseosa, list }),
    ).toBe(2_500);
    expect(
      resolveUnitPrice({ basePrice: 3_000, qty: 6, catalogProductId: gaseosa, list }),
    ).toBe(3_000);
  });

  it('si por debajo de la mínima no hay escalón, cae al porcentaje general', () => {
    expect(
      resolveUnitPrice({
        basePrice: 3_000,
        qty: 5,
        catalogProductId: gaseosa,
        list: {
          discountPercent: 10,
          items: [{ catalogProductId: gaseosa, price: 2_200, minQty: 50 }],
        },
      }),
    ).toBe(2_700);
  });

  it('devuelve pesos enteros: la tirilla por la cantidad tiene que dar el total', () => {
    // 3.000 menos 7 % son 2.790 exactos; con 13 % daría 2.610. Se redondea el
    // precio UNITARIO, no el total, para que lo que el cliente lee en la
    // tirilla multiplicado por la cantidad cuadre con lo que se le cobró.
    const precio = resolveUnitPrice({
      basePrice: 2_990,
      qty: 3,
      catalogProductId: gaseosa,
      list: { discountPercent: 7, items: [] },
    });
    expect(Number.isInteger(precio)).toBe(true);
    expect(precio).toBe(2_781);
  });

  it('nunca cobra negativo, ni con un descuento de 100 %', () => {
    expect(
      resolveUnitPrice({
        basePrice: 3_000,
        qty: 1,
        catalogProductId: gaseosa,
        list: { discountPercent: 100, items: [] },
      }),
    ).toBe(0);
  });

  it('un porcentaje en cero no es una lista vacía: se cobra mostrador', () => {
    expect(
      resolveUnitPrice({
        basePrice: 3_000,
        qty: 1,
        catalogProductId: gaseosa,
        list: { discountPercent: 0, items: [] },
      }),
    ).toBe(3_000);
  });

  it('una lista puede cobrar MÁS que mostrador si así se pactó', () => {
    // No se acota contra el precio base a propósito: hay negocios con lista de
    // "domicilio" o "evento" más cara. Acotarlo sería decidir por el dueño.
    expect(
      resolveUnitPrice({
        basePrice: 3_000,
        qty: 1,
        catalogProductId: gaseosa,
        list: { items: [{ catalogProductId: gaseosa, price: 3_500 }] },
      }),
    ).toBe(3_500);
  });
});

describe('pickTier · desempates', () => {
  const p = 'p-1';

  it('empatados en cantidad mínima, gana el más barato', () => {
    // Casi siempre es que alguien quiso corregir un precio y dejó los dos
    // renglones. El servicio lo rechaza al guardar; si uno se coló de antes,
    // aquí se resuelve a favor del cliente en vez de a la suerte del orden.
    const elegido = pickTier(
      [
        { catalogProductId: p, price: 2_800, minQty: 10 },
        { catalogProductId: p, price: 2_500, minQty: 10 },
      ],
      p,
      10,
    );
    expect(elegido?.price).toBe(2_500);
  });

  it('sin cantidad mínima, aplica desde la primera unidad', () => {
    expect(pickTier([{ catalogProductId: p, price: 2_500 }], p, 1)?.price).toBe(
      2_500,
    );
  });

  it('devuelve nada si ningún escalón alcanza', () => {
    expect(
      pickTier([{ catalogProductId: p, price: 2_500, minQty: 12 }], p, 11),
    ).toBeUndefined();
  });
});
