export const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'credit'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Canal digital de un cobro (ítem 6.4). El `method` de siempre no cambia
 * (datafono -> card; billeteras y QR -> transfer), así arqueo, asientos,
 * anulación y devoluciones siguen igual; el canal solo detalla por dónde entró
 * la plata para conciliarla contra el extracto.
 */
export const PAYMENT_CHANNELS = ['datafono', 'nequi', 'daviplata', 'qr'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

/** Medio de siempre al que pertenece cada canal. */
export const CHANNEL_METHOD: Record<PaymentChannel, PaymentMethod> = {
  datafono: 'card',
  nequi: 'transfer',
  daviplata: 'transfer',
  qr: 'transfer',
};

export const CARD_TYPES = ['debit', 'credit'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CARD_FRANCHISES = ['visa', 'mastercard', 'amex', 'diners', 'otra'] as const;
export type CardFranchise = (typeof CARD_FRANCHISES)[number];

/** Referencia libre: aprobación del datáfono, últimos 4 o número de la billetera. */
export const REFERENCE_PATTERN = /^[\p{L}\p{N} .\-/#*]{1,40}$/u;

export const SALE_STATUSES = ['completed', 'void'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** Tipo de descuento aplicado a la venta: monto fijo o porcentaje. */
export const DISCOUNT_TYPES = ['amount', 'percent'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];
