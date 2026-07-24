/** Estado de una cuenta abierta (comanda/mesa) del POS. */
export const ORDER_STATUSES = ['open', 'closed', 'void'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
