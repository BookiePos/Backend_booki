/**
 * Dividir la cuenta de una mesa.
 *
 * Hasta ahora una comanda se cobraba COMPLETA y de un solo golpe. En una mesa
 * eso casi nunca pasa: uno paga lo suyo, otros dos pagan juntos, y el último
 * paga lo que quede.
 *
 * La idea es una sola y sirve para las dos formas de dividir que la gente usa:
 * cada cobro paga un SUBCONJUNTO de la cuenta, y la comanda sigue abierta hasta
 * que no quede nada por pagar.
 *
 *   - "Yo pago la pizza y las dos cervezas" → se manda ese subconjunto.
 *   - "Somos cuatro, cada uno lo mismo" → se manda un cuarto de cada línea.
 *
 * Y el último cobro se manda SIN líneas, que significa "todo lo que falte". Eso
 * resuelve el problema de repartir diez unidades entre tres: los dos primeros
 * pagan 3,33 y el último paga lo que sobró, así la suma cuadra exactamente con
 * lo que se consumió. Nunca queda un pedazo de nadie colgando.
 */

/** Una línea de la comanda con lo que ya se pagó de ella. */
export interface OrderLineState {
  productId: string;
  qty: number;
  paidQty: number;
}

/** Lo que alguien quiere pagar ahora. */
export interface PayRequest {
  productId: string;
  qty: number;
}

/** Por debajo de esto la diferencia es del redondeo al repartir, no una deuda. */
export const EPSILON = 0.0005;

/** Lo que falta por pagar de cada producto de la comanda. */
export function remainingOf(
  lines: readonly OrderLineState[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const falta = l.qty - (l.paidQty ?? 0);
    out.set(l.productId, (out.get(l.productId) ?? 0) + falta);
  }
  return out;
}

/** Si ya no queda nada por cobrar. */
export function isFullyPaid(lines: readonly OrderLineState[]): boolean {
  return [...remainingOf(lines).values()].every((q) => q <= EPSILON);
}

export interface PaymentPlan {
  /** Lo que se va a facturar en ESTE cobro. */
  lines: PayRequest[];
  /** Cómo queda `paidQty` de cada línea después de cobrar. */
  paidAfter: number[];
  /** Si con este cobro la comanda queda saldada y se puede cerrar. */
  fullyPaid: boolean;
}

/**
 * Arma un cobro y valida que quepa en lo que falta.
 *
 * Sin `requested` se cobra TODO lo que quede, que es el cobro de siempre —la
 * comanda que se paga entera— y también el último de una cuenta dividida.
 *
 * Lanza `Error` con el motivo en llano; quien llama lo traduce a 400.
 */
export function planPayment(
  lines: readonly OrderLineState[],
  requested?: readonly PayRequest[],
): PaymentPlan {
  const falta = remainingOf(lines);
  const total = [...falta.values()].reduce((s, q) => s + q, 0);
  if (total <= EPSILON) {
    throw new Error('Esta cuenta ya está pagada completa');
  }

  // Sin subconjunto, se cobra todo lo que falta.
  const pedido = new Map<string, number>();
  if (!requested || requested.length === 0) {
    for (const [productId, qty] of falta) {
      if (qty > EPSILON) pedido.set(productId, qty);
    }
  } else {
    for (const r of requested) {
      if (!(r.qty > 0)) {
        throw new Error('La cantidad a cobrar debe ser mayor que cero');
      }
      pedido.set(r.productId, (pedido.get(r.productId) ?? 0) + r.qty);
    }
    for (const [productId, qty] of pedido) {
      const disponible = falta.get(productId);
      if (disponible === undefined) {
        throw new Error('Ese producto no está en la cuenta');
      }
      if (qty - disponible > EPSILON) {
        throw new Error(
          disponible <= EPSILON
            ? 'De ese producto ya se pagó todo'
            : `De ese producto solo quedan ${disponible} por pagar`,
        );
      }
    }
  }

  // Se reparte lo cobrado sobre las líneas, en orden, hasta agotar cada
  // producto. Una comanda puede tener el mismo producto en dos renglones —se
  // pidió otra ronda— y hay que ir llenando el primero antes que el segundo.
  const porRepartir = new Map(pedido);
  const paidAfter = lines.map((l) => l.paidQty ?? 0);
  lines.forEach((l, i) => {
    const restante = porRepartir.get(l.productId);
    if (!restante || restante <= EPSILON) return;
    const hueco = l.qty - (l.paidQty ?? 0);
    if (hueco <= EPSILON) return;
    const toma = Math.min(hueco, restante);
    paidAfter[i] = (l.paidQty ?? 0) + toma;
    porRepartir.set(l.productId, restante - toma);
  });

  const quedaDespues = lines.reduce(
    (s, l, i) => s + (l.qty - (paidAfter[i] ?? 0)),
    0,
  );

  return {
    lines: [...pedido.entries()].map(([productId, qty]) => ({ productId, qty })),
    paidAfter,
    fullyPaid: quedaDespues <= EPSILON,
  };
}

/**
 * Reparte la cuenta en `parts` partes iguales y devuelve la de `index`.
 *
 * La última parte se devuelve VACÍA a propósito: cobrarla sin líneas significa
 * "todo lo que falte", y así lo que no se pudo repartir exacto —diez unidades
 * entre tres— lo absorbe el último en pagar en vez de quedar colgando.
 */
export function evenShare(
  lines: readonly OrderLineState[],
  parts: number,
  index: number,
): PayRequest[] {
  if (parts < 2 || index >= parts - 1) return [];
  const falta = remainingOf(lines);
  const out: PayRequest[] = [];
  for (const [productId, qty] of falta) {
    // Se reparte sobre lo que QUEDA, no sobre el total: si ya pagaron dos,
    // dividir "entre tres" lo que falta es lo que la gente espera.
    const parte = Math.floor((qty / parts) * 1000) / 1000;
    if (parte > EPSILON) out.push({ productId, qty: parte });
  }
  return out;
}
