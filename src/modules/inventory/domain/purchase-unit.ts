/**
 * Unidad de compra distinta a la unidad de consumo.
 *
 * Todo el sistema costea en la unidad en que se CONSUME el insumo: la harina en
 * gramos, porque así la piden las recetas y así sale el costo de un lote de
 * galletas. Pero nadie compra harina por gramo. Llega en bultos de 25 kg y el
 * proveedor cotiza el bulto.
 *
 * `purchaseUnit` + `purchaseFactor` guardan esa presentación en el producto:
 * "bulto" y 25000 significan "un bulto trae 25.000 g". Con eso, los precios y
 * las entradas se digitan como llega la mercancía, mientras que lo que se
 * guarda —y de lo que viven recetas, kárdex y márgenes— sigue siendo el costo
 * por gramo.
 *
 * Los dos campos son OPCIONALES y van juntos o no van. Un producto sin
 * presentación de compra se compra en la misma unidad en que se consume, que es
 * como funcionaba el inventario entero antes de que esto existiera: por eso no
 * hay nada que migrar en las bases que ya están en producción.
 *
 * Ojo: no confundir con `weight`, que es el contenido de UNA unidad vendible
 * (una bolsa de mecato de 500 g). Aquí se describe el empaque con el que ENTRA
 * la mercancía, no el que sale.
 */

/** Tope de cordura del factor: más allá es un cero de más al teclear. */
export const MAX_PURCHASE_FACTOR = 10_000_000;

export interface PurchasePresentation {
  purchaseUnit?: string;
  purchaseFactor?: number;
}

/**
 * Valida y normaliza el par presentación/factor.
 *
 * Devuelve siempre los dos campos explícitos (con `undefined` cuando no hay
 * presentación) para que quien llama pueda asignarlos tal cual y así borrar una
 * presentación que existía antes.
 */
export function normalizePurchase(
  unit: string | undefined | null,
  factor: number | undefined | null,
): PurchasePresentation {
  const name = typeof unit === 'string' ? unit.trim() : '';
  const value = factor === undefined || factor === null ? null : Number(factor);

  // Sin nombre no hay presentación: el producto se compra como se consume.
  // Un factor suelto solo es un error si de verdad traía contenido; un 0 o un
  // vacío se entienden como "quitar la presentación".
  if (!name) {
    if (value !== null && value > 0) {
      throw new Error(
        'Falta el nombre de la presentación de compra (bulto, caja, garrafa…)',
      );
    }
    return { purchaseUnit: undefined, purchaseFactor: undefined };
  }

  // Con nombre, el factor es obligatorio: sin él no se sabe cuánto rinde.
  if (value === null || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Indica cuánto trae un ${name} para poder convertir la compra al consumo`,
    );
  }
  if (value > MAX_PURCHASE_FACTOR) {
    throw new Error(
      `El contenido de un ${name} es demasiado grande; revisa si sobra un cero`,
    );
  }

  return { purchaseUnit: name, purchaseFactor: value };
}

/**
 * Cuántas unidades de consumo entran al comprar `packs` presentaciones.
 * 3 bultos con factor 25000 ⇒ 75.000 g. Sin presentación, la cantidad ya viene
 * en unidades de consumo y pasa derecho.
 */
export function packsToStockQty(
  packs: number,
  factor?: number | null,
): number {
  if (!factor || factor <= 0) return packs;
  return packs * factor;
}

/**
 * Precio de una presentación a partir del costo por unidad de consumo.
 * $3,80 el gramo con factor 25000 ⇒ $95.000 el bulto.
 */
export function packCost(unitCost: number, factor?: number | null): number {
  if (!factor || factor <= 0) return unitCost;
  return unitCost * factor;
}

/**
 * El camino inverso: el proveedor cotiza $95.000 el bulto y hay que guardar el
 * costo por gramo. NO se redondea a peso entero a propósito —$95.000/25.000 son
 * $3,80 el gramo— porque redondear aquí inflaría cada receta; el redondeo a COP
 * se hace al final, sobre el total, con los helpers de `money.util`.
 */
export function unitCostFromPack(cost: number, factor?: number | null): number {
  if (!factor || factor <= 0) return cost;
  return cost / factor;
}
