/** Estados del ciclo de una orden de compra. */
export const PURCHASE_ORDER_STATUSES = [
  'draft', // borrador, editable
  'sent', // enviada al proveedor
  'partial', // recibida parcialmente
  'received', // recibida en su totalidad
  'cancelled', // anulada
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> =
  {
    draft: 'Borrador',
    sent: 'Enviada',
    partial: 'Recepción parcial',
    received: 'Recibida',
    cancelled: 'Anulada',
  };
