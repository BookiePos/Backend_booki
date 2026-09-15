/**
 * Con qué empaque suele salir lo que hay en el carrito.
 *
 * Puro dominio: sin Nest y sin Mongoose, para poder probarlo con datos a mano.
 *
 * La regla es deliberadamente una sola —"lo mismo que la última vez que
 * vendiste este mismo conjunto de productos"— y no un promedio ni una tasa por
 * producto. La razón es que extrapolar sale mal justo donde más se nota: si el
 * sistema aprende "una galleta = una bolsa" y alguien vende tres, sugerir tres
 * bolsas es peor que no sugerir nada, porque las tres galletas van en la misma
 * bolsa y quien cobra tiene que corregir a mano en cada venta. Repetir una
 * combinación que de verdad ocurrió no tiene ese problema.
 *
 * Cuando no hay historial manda la ficha del producto, que es lo que el negocio
 * configuró a propósito. Y si tampoco hay ficha, no se sugiere nada: una
 * sugerencia inventada se descuenta del inventario igual que una buena.
 */

/** Una venta pasada de la que sí se puede aprender (empaque elegido a mano). */
export interface VentaConEmpaque {
  /** Ids de los productos VENDIBLES que llevaba. */
  productIds: string[];
  /** Con qué empaque salió. */
  packaging: { productId: string; name: string; qty: number }[];
  /** Para desempatar: entre dos combinaciones igual de frecuentes, la reciente. */
  soldAt: Date;
}

/** Una línea de empaque sugerida para el cobro actual. */
export interface EmpaqueSugerido {
  productId: string;
  name: string;
  qty: number;
}

/** De dónde salió la sugerencia. El POS lo dice en pantalla. */
export type OrigenSugerencia = 'historial' | 'ficha' | 'ninguno';

export interface Sugerencia {
  lineas: EmpaqueSugerido[];
  origen: OrigenSugerencia;
  /** Cuántas ventas pasadas respaldan la sugerencia (0 si viene de la ficha). */
  apoyo: number;
}

/**
 * Identifica un carrito por el CONJUNTO de productos que lleva, sin cantidades.
 *
 * Sin cantidades a propósito: "dos empanadas" y "tres empanadas" salen en la
 * misma bolsa, y exigir que coincidan haría que casi ninguna venta se pareciera
 * a otra y la memoria no llegara a servir nunca.
 */
export function firmaDeCarrito(productIds: string[]): string {
  return [...new Set(productIds)].sort().join('|');
}

/** Identifica una combinación de empaque, para poder contar repeticiones. */
function firmaDeEmpaque(lineas: { productId: string; qty: number }[]): string {
  return lineas
    .map((l) => `${l.productId}:${l.qty}`)
    .sort()
    .join('|');
}

/**
 * Qué empaque sugerir para este carrito.
 *
 * @param cartProductIds ids de los vendibles que hay en el carrito.
 * @param historial ventas pasadas con empaque elegido a mano, en cualquier orden.
 * @param semilla empaque que las fichas de esos productos declaran, ya sumado.
 */
export function sugerirEmpaque(
  cartProductIds: string[],
  historial: VentaConEmpaque[],
  semilla: EmpaqueSugerido[],
): Sugerencia {
  const firma = firmaDeCarrito(cartProductIds);
  if (!firma) return { lineas: [], origen: 'ninguno', apoyo: 0 };

  const parecidas = historial.filter(
    (v) => firmaDeCarrito(v.productIds) === firma,
  );

  // Agrupa por combinación de empaque y se queda con la más repetida. El
  // desempate por fecha hace que, con dos costumbres igual de frecuentes, gane
  // la de ahora: es lo que uno espera cuando acaba de cambiar de bolsa.
  const grupos = new Map<
    string,
    { lineas: EmpaqueSugerido[]; veces: number; ultima: Date }
  >();
  for (const venta of parecidas) {
    const clave = firmaDeEmpaque(venta.packaging);
    const previo = grupos.get(clave);
    if (previo) {
      previo.veces += 1;
      if (venta.soldAt > previo.ultima) previo.ultima = venta.soldAt;
    } else {
      grupos.set(clave, {
        lineas: venta.packaging.map((l) => ({ ...l })),
        veces: 1,
        ultima: venta.soldAt,
      });
    }
  }

  const ganador = [...grupos.values()].sort(
    (a, b) => b.veces - a.veces || b.ultima.getTime() - a.ultima.getTime(),
  )[0];

  // Un grupo ganador SIN líneas es una respuesta legítima y no un hueco: quiere
  // decir que esto se ha vendido varias veces sin empaque, y el POS debe abrir
  // en "sin empaques" en vez de volver a proponer la bolsa de la ficha.
  if (ganador) {
    return { lineas: ganador.lineas, origen: 'historial', apoyo: ganador.veces };
  }

  const deFicha = semilla.filter((l) => l.qty > 0);
  if (deFicha.length > 0) {
    return { lineas: deFicha.map((l) => ({ ...l })), origen: 'ficha', apoyo: 0 };
  }
  return { lineas: [], origen: 'ninguno', apoyo: 0 };
}
