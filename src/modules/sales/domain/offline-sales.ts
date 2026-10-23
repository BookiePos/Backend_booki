import { fechaContablePedido } from './platform-orders';

/**
 * Modo offline del POS (ítem 6.3).
 *
 * Sin internet el terminal sigue cobrando en EFECTIVO y guarda la venta en una
 * cola local. El número que imprime el comprobante sale de un bloque que el
 * servidor le reservó antes, mientras había conexión, así que nunca choca con
 * otro terminal ni con una venta en línea.
 *
 * Los consecutivos offline van en su propia serie (`FVC-`, «venta en
 * contingencia») con su propio contador por sede. Así la serie normal `FV-`
 * sigue sin huecos: un bloque reservado que no se alcanza a gastar deja
 * números sin usar SOLO en la serie de contingencia, y cada uno queda
 * explicado por su reserva (quién, qué turno, qué rango).
 */
export const OFFLINE_PREFIX = 'FVC';

/** Tamaño del bloque por omisión y su techo por petición. */
export const OFFLINE_BLOCK_DEFAULT = 30;
export const OFFLINE_BLOCK_MAX = 100;

/** Contador atómico de la serie de contingencia de una sede. */
export function offlineCounterId(sedeId: string): string {
  return `sale-offline:${sedeId}`;
}

export function formatOfflineNumber(n: number): string {
  return `${OFFLINE_PREFIX}-${String(n).padStart(6, '0')}`;
}

/** El número entero de un consecutivo `FVC-000123`, o null si no es de la serie. */
export function parseOfflineNumber(saleNumber: string): number | null {
  const m = /^FVC-(\d{6,})$/.exec(saleNumber);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Motivos por los que una venta offline no se pudo registrar al sincronizar.
 * La venta NO se pierde: el terminal la deja en la bandeja con su motivo.
 *
 * `EN_PROCESO` es el único transitorio: otra petición con el mismo UUID está
 * corriendo y basta con reintentar.
 */
export const OFFLINE_CONFLICT_REASONS = [
  'TURNO_CERRADO',
  'SIN_STOCK',
  'PRODUCTO_INACTIVO',
  'TOTAL_DISTINTO',
  'NUMERO_INVALIDO',
  'NUMERO_USADO',
  'FECHA_INVALIDA',
  'NO_PERMITIDA_OFFLINE',
  'RECHAZADA',
  'EN_PROCESO',
] as const;
export type OfflineConflictReason = (typeof OFFLINE_CONFLICT_REASONS)[number];

export const OFFLINE_CONFLICT_CODE = 'OFFLINE_CONFLICT';

/** Lo que una venta offline puede traer (subconjunto de CreateSaleDto). */
export interface OfflineSaleShape {
  lines: { discountId?: string }[];
  payment?: { method: string; received?: number };
  payments?: unknown[];
  discount?: unknown;
  priceListId?: string;
  customerId?: string;
  orderType?: string;
  delivery?: unknown;
}

/**
 * Qué impide registrar esta venta como offline. Vacío = permitida.
 *
 * Solo efectivo: es el único medio que no depende de la red. Fuera quedan el
 * fiado (hay que validar al deudor), la tarjeta y la transferencia (el
 * comprobante del banco se valida en línea; ítem 6.4), el cobro mixto, los
 * descuentos y las listas de precios (piden permiso y precio del servidor), el
 * cliente registrado (su lista de precios) y el domicilio (la tarifa la pone el
 * servidor por zona). Lo impreso offline tiene que ser exactamente lo que el
 * servidor va a cobrar.
 */
export function offlineSaleViolations(dto: OfflineSaleShape): string[] {
  const out: string[] = [];
  if (dto.payments !== undefined) out.push('El cobro mixto no se permite sin conexión');
  if (!dto.payment || dto.payment.method !== 'cash') {
    out.push('Sin conexión solo se cobra en efectivo');
  }
  if (dto.discount !== undefined || dto.lines.some((l) => l.discountId)) {
    out.push('Los descuentos no se aplican sin conexión');
  }
  if (dto.priceListId) out.push('Las listas de precios no se aplican sin conexión');
  if (dto.customerId) out.push('El cliente registrado no se usa sin conexión');
  if (dto.orderType === 'domicilio' || dto.delivery !== undefined) {
    out.push('Los domicilios no se registran sin conexión');
  }
  return out;
}

/** Holgura del reloj del terminal frente al servidor. */
export const OFFLINE_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Vida de un bloque reservado. Pasado este tiempo sus números ya no sirven para
 * cobrar: un bloque viejo guardado en un terminal no puede numerar ventas de
 * cualquier día (el terminal pide otro al volver la red).
 */
export const OFFLINE_RESERVATION_TTL_MS = 48 * 3_600_000;

export function reservationExpiresAt(reservedAt: Date): Date {
  return new Date(reservedAt.getTime() + OFFLINE_RESERVATION_TTL_MS);
}

/**
 * La fecha original es creíble: no antes de que se reservara el bloque (el
 * número no existía), no después de que venciera (48 h) ni en el futuro, con la
 * holgura del reloj.
 */
export function soldAtIsPlausible(soldAt: Date, reservedAt: Date, now: Date): boolean {
  const t = soldAt.getTime();
  if (Number.isNaN(t)) return false;
  return (
    t >= reservedAt.getTime() - OFFLINE_CLOCK_SKEW_MS &&
    t <= reservationExpiresAt(reservedAt).getTime() + OFFLINE_CLOCK_SKEW_MS &&
    t <= now.getTime() + OFFLINE_CLOCK_SKEW_MS
  );
}

/**
 * El cobro cae dentro del turno de caja de la reserva: entre su apertura y su
 * cierre (si ya cerró), con la holgura del reloj. Una venta «cobrada» después
 * de cerrar el arqueo no puede entrar a ese efectivo.
 */
export function soldAtEnTurno(soldAt: Date, openedAt: Date, closedAt?: Date): boolean {
  const t = soldAt.getTime();
  if (Number.isNaN(t)) return false;
  if (t < openedAt.getTime() - OFFLINE_CLOCK_SKEW_MS) return false;
  return !closedAt || t <= closedAt.getTime() + OFFLINE_CLOCK_SKEW_MS;
}

/**
 * Fecha del asiento de una venta offline, con el mismo criterio que los pedidos
 * de plataforma (`fechaContablePedido`): el día del cobro si es del mes en
 * curso; si el mes ya pasó (pudo cerrarse), hoy. Una fecha futura (reloj del
 * terminal adelantado sobre la medianoche) también cae en hoy. `soldAt` queda
 * en la venta como dato informativo.
 */
export function fechaContableOffline(diaDelCobro: string, hoy: string): string {
  const r = fechaContablePedido(diaDelCobro, hoy);
  return 'fecha' in r ? r.fecha : hoy;
}

/**
 * Conflictos con salida: quien tenga permiso de autorizar anulaciones puede
 * registrar la venta con lo que se cobró (precio del comprobante, producto
 * inactivo o sin stock registrado). El efectivo ya está en el cajón.
 */
export const OFFLINE_OVERRIDABLE: readonly OfflineConflictReason[] = [
  'TOTAL_DISTINTO',
  'SIN_STOCK',
  'PRODUCTO_INACTIVO',
];
