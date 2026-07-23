/** Estado de un turno de caja. */
export const CAJA_STATUSES = ['open', 'closed'] as const;
export type CajaStatus = (typeof CAJA_STATUSES)[number];

/**
 * Tipo de movimiento manual de caja:
 * - in: ingreso de efectivo (fondo, préstamo, ajuste +).
 * - out: retiro / gasto pagado de la caja.
 * - sangria: retiro de seguridad (se lleva el efectivo a otro lugar).
 */
export const CAJA_MOVEMENT_TYPES = ['in', 'out', 'sangria'] as const;
export type CajaMovementType = (typeof CAJA_MOVEMENT_TYPES)[number];
