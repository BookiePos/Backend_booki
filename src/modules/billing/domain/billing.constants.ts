/**
 * Constantes del módulo de facturación/suscripciones (Wompi). Viven aparte de
 * schemas y servicios para reusarse sin ciclos de importación.
 */

/** Ciclo de cobro del plan. Los complementos se prorratean al ciclo. */
export const BILLING_CYCLES = ['monthly', 'annual'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** Estado de la suscripción recurrente. */
export const SUBSCRIPTION_STATUSES = [
  'pending', // creada, esperando aprobación del primer cobro
  'active', // al día
  'past_due', // un cobro falló; en reintentos (dunning)
  'canceled', // cancelada por el dueño o suspendida tras agotar reintentos
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Estado de un pago (transacción Wompi) registrado. */
export const PAYMENT_STATUSES = [
  'pending',
  'approved',
  'declined',
  'voided',
  'error',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Tipo de pago: alta/renovación de suscripción o compra única de documentos. */
export const PAYMENT_KINDS = ['subscription', 'renewal', 'docPackage'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** Moneda Wompi (Colombia). */
export const WOMPI_CURRENCY = 'COP';

/** Reintentos de cobro antes de suspender la cuenta (dunning). */
export const MAX_CHARGE_RETRIES = 3;

/** Espera mínima entre reintentos de cobro de una suscripción en mora. */
export const RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 h

/** Mapea el estado de una transacción Wompi a nuestro `PaymentStatus`. */
export function mapWompiStatus(status: string): PaymentStatus {
  switch (status) {
    case 'APPROVED':
      return 'approved';
    case 'DECLINED':
      return 'declined';
    case 'VOIDED':
      return 'voided';
    case 'ERROR':
      return 'error';
    default:
      return 'pending';
  }
}
