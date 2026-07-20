export const PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SALE_STATUSES = ['completed', 'void'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];
