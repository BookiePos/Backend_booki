/** Tipo de descuento predefinido: porcentaje del precio o monto fijo en pesos. */
export const DISCOUNT_TYPES = ['percent', 'amount'] as const;
export type DiscountKind = (typeof DISCOUNT_TYPES)[number];
