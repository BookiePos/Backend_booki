/**
 * Constantes de dominio del módulo de inventario.
 */

/** Tipos de movimiento del kardex. */
export const MOVEMENT_TYPES = [
  'entry', // entrada de mercancía (compra/recepción)
  'adjust_in', // ajuste positivo (conteo, corrección)
  'adjust_out', // ajuste negativo (conteo, corrección)
  'waste', // merma / baja (daño, vencimiento)
  'transfer_out', // salida por traslado entre sedes
  'transfer_in', // entrada por traslado entre sedes
  'sale', // salida por venta (lo usará el POS)
] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Razones de ajuste/baja de stock. */
export const ADJUST_REASONS = [
  'conteo', // diferencia detectada en conteo físico
  'dano', // producto dañado
  'vencimiento', // producto vencido
  'merma', // merma operativa (cocina, manipulación)
  'otro',
] as const;

export type AdjustReason = (typeof ADJUST_REASONS)[number];

/** Razones que se registran como merma (waste) en vez de ajuste. */
export const WASTE_REASONS: AdjustReason[] = ['dano', 'vencimiento', 'merma'];

/** Unidades de medida sugeridas (se admite cualquier string corto). */
export const SUGGESTED_UNITS = [
  'und',
  'kg',
  'g',
  'lb',
  'l',
  'ml',
  'paquete',
  'caja',
  'bulto',
] as const;
