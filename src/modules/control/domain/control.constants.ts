/**
 * Constantes del control-plane (registro de empresas). Viven aparte de los
 * schemas para reusarse en DTOs y servicios sin ciclos de importación.
 */

/** Nombre de la conexión Mongoose dedicada a la base de control. */
export const CONTROL_CONNECTION = 'control';

/**
 * Planes comercializados. El catálogo completo (precios, cuotas, features,
 * complementos) vive en `plans.ts`; aquí se re-exporta lo esencial para no
 * romper los imports existentes.
 */
export { BUSINESS_PLANS } from './plans';
export type { BusinessPlan } from './plans';

/** Giro del negocio: cambia el modo por defecto del POS por sede. */
export const BUSINESS_TYPES = ['restaurante', 'retail'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Estado de la suscripción de la empresa. */
export const BUSINESS_STATUSES = ['trial', 'active', 'suspended'] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

/** Días de prueba sin tarjeta (según la web pública). */
export const TRIAL_DAYS = 14;
