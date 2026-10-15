/**
 * Constantes del módulo de facturación/suscripciones (Wompi). Viven aparte de
 * schemas y servicios para reusarse sin ciclos de importación.
 */

/**
 * Ciclo de cobro del plan. La lista y sus precios viven en el catálogo
 * comercial (`control/domain/plans`), que es la fuente única; aquí solo se
 * reexportan para que el módulo de facturación no tenga que conocer esa ruta.
 */
export {
  BILLING_CYCLES,
  CYCLE_MONTHS,
  CYCLE_BILLED_MONTHS,
} from '../../control/domain/plans';
export type { BillingCycle } from '../../control/domain/plans';

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

/**
 * Ventana de validez del `timestamp` (segundos UNIX) de un evento del webhook.
 *
 * Hacia atrás, 25 h: Wompi reintenta el MISMO evento firmado a los 30 min, 3 h
 * y 24 h cuando no recibe un 200, y una ventana más corta tiraría esos
 * reintentos legítimos. Una hora de margen cubre la demora de la entrega. La
 * repetición dentro de la ventana no es peligrosa: el pago se aplica una sola
 * vez (`Payment.applied`) y la transacción se confirma contra la API antes.
 * Hacia adelante, 5 min de desfase de reloj entre servidores.
 */
export const WEBHOOK_MAX_AGE_MS = 25 * 60 * 60 * 1000;
export const WEBHOOK_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Campos de la transacción que la firma de un evento debe cubrir sí o sí. Wompi
 * dice que `signature.properties` puede variar; si alguna vez dejara fuera uno
 * de estos, el evento se rechaza y el pago lo resuelve la consulta o el barrido.
 */
export const WEBHOOK_SIGNED_PROPERTIES = [
  'transaction.id',
  'transaction.status',
  'transaction.amount_in_cents',
] as const;

/** Reintentos de cobro antes de suspender la cuenta (dunning). */
export const MAX_CHARGE_RETRIES = 3;

/**
 * Espera mínima entre reintentos de cobro de una suscripción en mora.
 *
 * Menos de 24 h a propósito: en Vercel el barrido corre una vez al día y el cron
 * del plan Hobby puede dispararse en cualquier minuto de su hora, así que entre
 * un intento y el del día siguiente pueden pasar algo menos de 24 h. Con 24 h
 * justas se saltaría ese reintento y los tres intentos tardarían ~6 días.
 */
export const RETRY_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20 h

/**
 * Antigüedad a partir de la cual un cobro que sigue "pendiente" se consulta
 * directamente a la pasarela. El webhook normalmente resuelve en segundos; si
 * se pierde, sin esta consulta el pago se queda pendiente para siempre y la
 * suscripción nunca se activa ni se vuelve a cobrar.
 */
export const PENDING_RECONCILE_AFTER_MS = 15 * 60 * 1000; // 15 min

/**
 * Duración de la reserva para aplicar un pago aprobado. Los efectos tardan
 * milisegundos; si la reserva sigue ahí pasado este tiempo, el proceso que la
 * tomó murió a mitad y otro puede retomarla.
 */
export const APPLY_LEASE_MS = 10 * 60 * 1000; // 10 min

/**
 * Versión del protocolo de aplicación (`Payment.applyVersion`). La pone la
 * reserva de `applyApproved`. Un pago `approved` SIN esta marca viene del
 * código anterior, que no anotaba qué efectos hizo: no se re-aplica solo (se
 * revisa a mano con src/datos/2026-10-pagos-aprobados-legado-informe.ts).
 */
export const APPLY_VERSION = 2;

/** Tope de cobros pendientes que se reconcilian en un mismo barrido. */
export const PENDING_RECONCILE_LIMIT = 100;

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
