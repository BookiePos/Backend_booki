/**
 * Constantes de dominio del módulo de Producción.
 *
 * Producción es el hermano del inventario: no compra ni vende, TRANSFORMA. Una
 * orden consume insumos que ya están en la sede y devuelve un terminado a esa
 * misma sede. Por eso el valor no entra ni sale del negocio —solo cambia de
 * ítem— y ningún asiento contable nace aquí.
 */

/** Estados del ciclo de una orden de producción. */
export const PRODUCTION_ORDER_STATUSES = [
  'draft', // borrador, editable
  'in_progress', // en fabricación (ya no se edita)
  'done', // terminada: insumos consumidos y terminado en stock
  'cancelled', // anulada sin consumir nada
] as const;

export type ProductionOrderStatus =
  (typeof PRODUCTION_ORDER_STATUSES)[number];

export const PRODUCTION_ORDER_STATUS_LABELS: Record<
  ProductionOrderStatus,
  string
> = {
  draft: 'Borrador',
  in_progress: 'En proceso',
  done: 'Terminada',
  cancelled: 'Anulada',
};

/** Estados desde los que una orden todavía puede cerrarse. */
export const OPEN_PRODUCTION_STATUSES: ProductionOrderStatus[] = [
  'draft',
  'in_progress',
];

/** Prefijo del consecutivo legible de las órdenes (OP-000001). */
export const PRODUCTION_ORDER_PREFIX = 'OP';

/** Clave de la secuencia en la colección compartida `counters`. */
export const PRODUCTION_COUNTER_KEY = 'production_order';

/** Prefijo del lote que genera el terminado de una orden. */
export const PRODUCTION_LOT_PREFIX = 'OP';

/**
 * Nota que queda en el kárdex por cada movimiento de una orden.
 *
 * Es el único hilo que une un insumo consumido con la orden que lo usó, y de
 * ahí con el terminado que salió: la trazabilidad hacia adelante lo lee para
 * responder "este bulto de harina, ¿en qué tandas entró y a quién se vendió?".
 *
 * Por eso escribirla y leerla viven juntas. Cambiar el texto de un lado sin el
 * otro no rompe nada visible: simplemente la trazabilidad deja de encontrar
 * las órdenes, y nadie se entera hasta que el INVIMA pregunta.
 */
export function productionNote(orderNumber: string): string {
  return `Producción ${orderNumber}`;
}

/** Saca el número de orden de una nota del kárdex. Null si no es una. */
export function orderNumberFromNote(note?: string | null): string | null {
  if (!note) return null;
  const m = /^Producción\s+(\S+)/.exec(note.trim());
  return m?.[1] ?? null;
}
