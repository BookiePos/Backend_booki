/**
 * Devolución PARCIAL de una venta.
 *
 * Anular la venta entera ya existía; lo que faltaba era devolver 2 de 10. Y en
 * una tienda eso es lo normal: el cliente se lleva una caja, le sale una unidad
 * mala y vuelve con esa.
 *
 * Tres cosas se deciden en cada devolución y ninguna se puede adivinar:
 *
 * 1. CUÁNTO se devuelve de cada línea.
 * 2. Si lo devuelto vuelve a ser VENDIBLE o se va a la basura. Una gaseosa
 *    que el cliente no abrió vuelve al estante; una torta manoseada no.
 * 3. CÓMO se le devuelve la plata (efectivo de la caja, o nada si fue un
 *    cambio por otro producto).
 *
 * Lo que se le devuelve al cliente es lo que PAGÓ por esa línea, no el precio
 * de lista: si la venta llevaba descuento, el descuento también se devuelve en
 * proporción. Devolver de más es regalar plata; devolver de menos es una queja
 * en el mostrador.
 */

/** Por qué vuelve la mercancía. Queda en el registro y sirve para reportes. */
export const RETURN_REASONS = [
  'defectuoso', // vino malo o dañado
  'equivocado', // no era lo que pidió
  'sobrante', // compró de más y devuelve
  'garantia',
  'otro',
] as const;

export type ReturnReason = (typeof RETURN_REASONS)[number];

/** Qué se hace con lo devuelto. */
export const RESTOCK_MODES = [
  'inventory', // vuelve al estante, se puede volver a vender
  'waste', // se va a merma: volvió, pero no sirve
] as const;

export type RestockMode = (typeof RESTOCK_MODES)[number];

/** Cómo se le devuelve la plata al cliente. */
export const REFUND_METHODS = [
  'cash', // sale de la caja del turno
  'transfer', // se le consigna
  'credit_note', // queda a favor (no sale plata hoy)
  'none', // cambio por otro producto: no se devuelve plata
] as const;

export type RefundMethod = (typeof REFUND_METHODS)[number];

/** Una línea de la venta, con lo que hace falta para calcular la devolución. */
export interface SoldLine {
  productId: string;
  qty: number;
  /** Base gravable de la línea: ya neta de descuentos. */
  taxBase: number;
  /** IVA de la línea, incluido en lo que pagó el cliente. */
  taxAmount: number;
}

/** Lo que se pide devolver de una línea. */
export interface ReturnRequest {
  productId: string;
  qty: number;
}

export interface ReturnedLine {
  productId: string;
  qty: number;
  /** Lo que se le devuelve al cliente por esta línea, con IVA. */
  refund: number;
  /** Parte de ese reembolso que es IVA (para reversar el impuesto). */
  refundTax: number;
}

/** Redondeo a peso: el peso colombiano no usa centavos en caja. */
function cop(amount: number): number {
  return Math.round(amount);
}

/**
 * Cuánto se le devuelve por una línea.
 *
 * Se parte de `taxBase + taxAmount`, que es lo que el cliente PAGÓ de verdad
 * por esa línea: ya viene neto del descuento de línea y de la parte que le
 * tocó del descuento de toda la venta. Usar `unitPrice × qty` devolvería el
 * precio de lista y regalaría el descuento otra vez.
 *
 * La propina no entra: se cobró encima del total y ya se repartió.
 */
export function refundForLine(line: SoldLine, qty: number): ReturnedLine {
  const proporcion = line.qty > 0 ? qty / line.qty : 0;
  const pagado = line.taxBase + line.taxAmount;
  return {
    productId: line.productId,
    qty,
    refund: cop(pagado * proporcion),
    refundTax: cop(line.taxAmount * proporcion),
  };
}

export interface ReturnPlan {
  lines: ReturnedLine[];
  refundTotal: number;
  refundTax: number;
}

/**
 * Arma la devolución y valida las cantidades.
 *
 * `alreadyReturned` lleva lo que ya se devolvió antes de esta vez, por
 * producto: sin eso, devolver 2 de 10 tres veces seguidas podría sacar 6 de
 * una venta de… 2, si el cliente insiste y nadie está mirando.
 *
 * Lanza `Error` con el motivo en llano; quien llama lo traduce a 400.
 */
export function buildReturnPlan(
  soldLines: readonly SoldLine[],
  requests: readonly ReturnRequest[],
  alreadyReturned: ReadonlyMap<string, number>,
): ReturnPlan {
  if (requests.length === 0) {
    throw new Error('No hay nada que devolver');
  }

  const porProducto = new Map<string, SoldLine>();
  for (const l of soldLines) porProducto.set(l.productId, l);

  const pedidoPorProducto = new Map<string, number>();
  for (const r of requests) {
    if (!(r.qty > 0)) {
      throw new Error('La cantidad a devolver debe ser mayor que cero');
    }
    pedidoPorProducto.set(
      r.productId,
      (pedidoPorProducto.get(r.productId) ?? 0) + r.qty,
    );
  }

  const lines: ReturnedLine[] = [];
  for (const [productId, qty] of pedidoPorProducto) {
    const vendida = porProducto.get(productId);
    if (!vendida) {
      throw new Error('Ese producto no estaba en la venta');
    }
    const yaDevuelto = alreadyReturned.get(productId) ?? 0;
    const disponible = vendida.qty - yaDevuelto;
    if (qty > disponible) {
      throw new Error(
        yaDevuelto > 0
          ? `De ese producto ya se devolvieron ${yaDevuelto} de ${vendida.qty}: quedan ${disponible}`
          : `No se pueden devolver ${qty} si solo se vendieron ${vendida.qty}`,
      );
    }
    lines.push(refundForLine(vendida, qty));
  }

  // El total es la SUMA de las líneas ya redondeadas, no el redondeo de la
  // suma: así lo que se anota por línea cuadra exactamente con lo que sale de
  // la caja, que es lo que alguien va a contar al cerrar el turno.
  return {
    lines,
    refundTotal: lines.reduce((s, l) => s + l.refund, 0),
    refundTax: lines.reduce((s, l) => s + l.refundTax, 0),
  };
}

/**
 * Reparte las porciones de lote que consumió la venta entre lo que vuelve.
 *
 * Si de un insumo salieron 500 g repartidos en dos lotes y vuelve la quinta
 * parte, entran 100 g repartidos igual. Devolverlo todo a un solo lote
 * descuadraría el costo de los otros.
 */
export function prorateLots(
  consumedLots: readonly { lotId?: string; qty: number; unitCost?: number }[],
  soldQty: number,
  returnedQty: number,
): { lotId?: string; qty: number; unitCost?: number }[] {
  if (soldQty <= 0 || returnedQty <= 0) return [];
  const proporcion = Math.min(returnedQty / soldQty, 1);
  return consumedLots
    .map((cl) => ({
      lotId: cl.lotId,
      qty: cl.qty * proporcion,
      unitCost: cl.unitCost,
    }))
    .filter((cl) => cl.qty > 0);
}
