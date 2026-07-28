export const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'credit'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SALE_STATUSES = ['completed', 'void'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** Tipo de descuento aplicado a la venta: monto fijo o porcentaje. */
export const DISCOUNT_TYPES = ['amount', 'percent'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];
