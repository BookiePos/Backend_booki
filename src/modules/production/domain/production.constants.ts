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
