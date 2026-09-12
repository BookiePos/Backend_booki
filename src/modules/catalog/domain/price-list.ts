/**
 * Listas de precios: vender lo mismo a distinto precio según a quién.
 *
 * Hasta ahora un producto tenía UN `salePrice` y punto. Para venderle más
 * barato a una tienda que compra por cajas había que duplicar el producto o
 * descontar a mano en cada venta — y descontar a mano depende de que el cajero
 * se acuerde, así que unas veces sí y otras no.
 *
 * Una lista es un conjunto de reglas que se aplica encima del precio del
 * catálogo. Se arma de dos maneras, y se pueden combinar:
 *
 * 1. Un **porcentaje general**: "mayorista es 12 % menos que mostrador". Es una
 *    sola cifra y sirve para arrancar el mismo día, sin teclear trescientos
 *    precios.
 * 2. **Precios por producto**, que mandan sobre el porcentaje. Y cada uno puede
 *    exigir una cantidad mínima, que es como se hace el precio por cantidad:
 *    la gaseosa a $2.500 desde 12 unidades y a $2.200 desde 50.
 *
 * El precio del catálogo (`salePrice`) sigue siendo el de mostrador: es el que
 * se cobra cuando no hay lista, que es la venta normal del día.
 */

/** Un precio pactado para un producto dentro de una lista. */
export interface PriceListItem {
  catalogProductId: string;
  /** Precio unitario, con IVA incluido como todo `salePrice`. */
  price: number;
  /** Desde cuántas unidades aplica. Sin valor, aplica siempre. */
  minQty?: number;
}

/** Las reglas de una lista, sin la parte de Mongoose. */
export interface PriceListRules {
  /** Descuento general sobre el precio de mostrador, 0–100. */
  discountPercent?: number;
  items: PriceListItem[];
}

/** Tope del descuento general: más allá, el precio sería regalado o negativo. */
export const MAX_DISCOUNT_PERCENT = 100;

/**
 * Elige el escalón que aplica a esta cantidad.
 *
 * Con varios precios para el mismo producto gana el de mayor `minQty` entre
 * los que la cantidad alcanza: comprando 60 gaseosas se paga el precio de 50,
 * no el de 12. Si dos escalones empatan en `minQty`, gana el más barato, que
 * es lo que el cliente esperaría que pasara.
 */
export function pickTier(
  items: readonly PriceListItem[],
  catalogProductId: string,
  qty: number,
): PriceListItem | undefined {
  let elegido: PriceListItem | undefined;
  for (const item of items) {
    if (item.catalogProductId !== catalogProductId) continue;
    const min = item.minQty ?? 0;
    if (qty < min) continue;
    if (!elegido) {
      elegido = item;
      continue;
    }
    const minElegido = elegido.minQty ?? 0;
    if (min > minElegido || (min === minElegido && item.price < elegido.price)) {
      elegido = item;
    }
  }
  return elegido;
}

/**
 * Precio unitario que hay que cobrar.
 *
 * El orden importa y es de lo más específico a lo más general:
 *   1. Sin lista, el precio de mostrador. La venta normal no cambia.
 *   2. Un precio pactado para ESE producto cuya cantidad mínima se alcanza.
 *   3. El porcentaje general de la lista.
 *   4. Si nada aplica, el precio de mostrador.
 *
 * Devuelve pesos enteros: el redondeo se hace aquí, sobre el precio unitario,
 * y no al final sobre el total, para que lo que ve el cliente en la tirilla
 * multiplicado por la cantidad dé exactamente el total de la línea.
 */
export function resolveUnitPrice(opts: {
  basePrice: number;
  qty: number;
  catalogProductId: string;
  list?: PriceListRules | null;
}): number {
  const { basePrice, qty, catalogProductId, list } = opts;
  if (!list) return Math.round(basePrice);

  const tier = pickTier(list.items ?? [], catalogProductId, qty);
  if (tier) return Math.max(0, Math.round(tier.price));

  const pct = list.discountPercent ?? 0;
  if (pct > 0) {
    const limitado = Math.min(pct, MAX_DISCOUNT_PERCENT);
    return Math.max(0, Math.round(basePrice * (1 - limitado / 100)));
  }

  return Math.round(basePrice);
}
