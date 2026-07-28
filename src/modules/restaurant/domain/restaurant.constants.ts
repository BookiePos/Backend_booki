/**
 * Restaurante: mesas, comandas, propina e impuesto al consumo.
 *
 * Tarifas por defecto (Colombia). El INC (8%) refleja el impuesto `INC_8` del
 * motor core-tax; la propina sugerida (10%) refleja el parámetro
 * `propina.sugerida` de core-params. Se dejan como constantes para mantener el
 * módulo autónomo, pero pueden centralizarse en esos motores más adelante.
 */
export const DEFAULT_INC_RATE = 8;
export const DEFAULT_TIP_RATE = 10;

/** Estado físico de una mesa. */
export const TABLE_STATUSES = ['free', 'occupied', 'bill_requested'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  free: 'Libre',
  occupied: 'Ocupada',
  bill_requested: 'Pide cuenta',
};

/** Estado de una comanda/cuenta. */
export const ORDER_STATUSES = [
  'open', // abierta, tomando pedido
  'sent', // enviada a cocina
  'billed', // cuenta pedida
  'closed', // pagada / cerrada
  'cancelled', // anulada
] as const;
export type RestaurantOrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<RestaurantOrderStatus, string> = {
  open: 'Abierta',
  sent: 'En cocina',
  billed: 'Cuenta pedida',
  closed: 'Cerrada',
  cancelled: 'Anulada',
};

/** Estaciones de cocina donde se imprime la comanda. */
export const KITCHEN_STATIONS = ['cocina', 'barra', 'parrilla', 'postres'] as const;
export type KitchenStation = (typeof KITCHEN_STATIONS)[number];
