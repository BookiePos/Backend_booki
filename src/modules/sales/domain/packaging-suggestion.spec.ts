import { describe, it, expect } from 'vitest';
import {
  VentaConEmpaque,
  firmaDeCarrito,
  sugerirEmpaque,
} from './packaging-suggestion';

/**
 * Qué empaque proponer al cobrar.
 *
 * Lo que se protege aquí es sobre todo lo que la sugerencia NO debe hacer:
 * inventar, extrapolar cantidades y confundir "salió sin empaque" con "no se
 * sabe". Cada línea sugerida termina descontándose del inventario si quien
 * cobra la acepta, así que una sugerencia mala cuesta lo mismo que una buena.
 */
describe('sugerirEmpaque', () => {
  const GALLETA = 'g1';
  const CAFE = 'c1';
  const BOLSA = { productId: 'b1', name: 'Bolsa kraft', qty: 1 };
  const VASO = { productId: 'v1', name: 'Vaso 8oz', qty: 1 };

  function venta(
    productIds: string[],
    packaging: { productId: string; name: string; qty: number }[],
    dia = 1,
  ): VentaConEmpaque {
    return { productIds, packaging, soldAt: new Date(2026, 8, dia) };
  }

  it('sin historial propone lo que dice la ficha del producto', () => {
    const r = sugerirEmpaque([GALLETA], [], [BOLSA]);

    expect(r.origen).toBe('ficha');
    expect(r.lineas).toEqual([BOLSA]);
    expect(r.apoyo).toBe(0);
  });

  it('sin historial y sin ficha no propone nada', () => {
    // Deliberado: es preferible que quien cobra elija a que el sistema se
    // invente una bolsa y la descuente del inventario.
    const r = sugerirEmpaque([GALLETA], [], []);

    expect(r.origen).toBe('ninguno');
    expect(r.lineas).toEqual([]);
  });

  it('con historial manda lo que de verdad se usó, no la ficha', () => {
    const historial = [
      venta([GALLETA], [VASO]),
      venta([GALLETA], [VASO], 2),
    ];

    const r = sugerirEmpaque([GALLETA], historial, [BOLSA]);

    expect(r.origen).toBe('historial');
    expect(r.lineas).toEqual([VASO]);
    expect(r.apoyo).toBe(2);
  });

  it('elige la combinación más repetida, no la última', () => {
    const historial = [
      venta([GALLETA], [BOLSA], 1),
      venta([GALLETA], [BOLSA], 2),
      venta([GALLETA], [VASO], 5), // más reciente, pero una sola vez
    ];

    const r = sugerirEmpaque([GALLETA], historial, []);

    expect(r.lineas).toEqual([BOLSA]);
    expect(r.apoyo).toBe(2);
  });

  it('con dos costumbres igual de frecuentes gana la reciente', () => {
    // Es lo que uno espera justo después de cambiar de proveedor de bolsas.
    const historial = [
      venta([GALLETA], [BOLSA], 1),
      venta([GALLETA], [VASO], 9),
    ];

    const r = sugerirEmpaque([GALLETA], historial, []);

    expect(r.lineas).toEqual([VASO]);
  });

  it('"se vendió varias veces sin empaque" es una respuesta, no un hueco', () => {
    // Si esto cayera en la ficha, el POS volvería a proponer la bolsa que el
    // cajero lleva un mes quitando a mano en cada venta.
    const historial = [venta([GALLETA], []), venta([GALLETA], [], 2)];

    const r = sugerirEmpaque([GALLETA], historial, [BOLSA]);

    expect(r.origen).toBe('historial');
    expect(r.lineas).toEqual([]);
  });

  it('no mezcla el historial de otro carrito', () => {
    const historial = [venta([CAFE], [VASO]), venta([CAFE], [VASO], 2)];

    const r = sugerirEmpaque([GALLETA], historial, [BOLSA]);

    expect(r.origen).toBe('ficha');
    expect(r.lineas).toEqual([BOLSA]);
  });

  it('reconoce el carrito aunque cambien las cantidades', () => {
    // Tres galletas van en la misma bolsa que dos: exigir que la cantidad
    // coincidiera haría que la memoria no llegara a servir nunca.
    const historial = [venta([GALLETA, GALLETA], [BOLSA])];

    const r = sugerirEmpaque([GALLETA], historial, []);

    expect(r.origen).toBe('historial');
    expect(r.lineas).toEqual([BOLSA]);
  });

  it('reconoce el carrito aunque cambie el orden de los productos', () => {
    const historial = [venta([CAFE, GALLETA], [BOLSA, VASO])];

    const r = sugerirEmpaque([GALLETA, CAFE], historial, []);

    expect(r.origen).toBe('historial');
    expect(r.lineas).toEqual([BOLSA, VASO]);
  });

  it('un carrito vacío no propone nada', () => {
    expect(sugerirEmpaque([], [], [BOLSA]).origen).toBe('ninguno');
  });

  it('no devuelve las mismas referencias que el historial', () => {
    // El POS edita las cantidades sugeridas; si compartieran objeto, editarlas
    // reescribiría la memoria de la que salieron.
    const historial = [venta([GALLETA], [BOLSA])];

    const r = sugerirEmpaque([GALLETA], historial, []);
    r.lineas[0].qty = 99;

    expect(BOLSA.qty).toBe(1);
  });
});

describe('firmaDeCarrito', () => {
  it('no distingue repeticiones ni orden', () => {
    expect(firmaDeCarrito(['b', 'a', 'a'])).toBe(firmaDeCarrito(['a', 'b']));
  });
});
