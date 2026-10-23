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
 * La fecha original es creíble: no antes de que se reservara el bloque (el
 * número no existía) ni en el futuro, con la holgura del reloj.
 */
export function soldAtIsPlausible(soldAt: Date, reservedAt: Date, now: Date): boolean {
  const t = soldAt.getTime();
  if (Number.isNaN(t)) return false;
  return (
    t >= reservedAt.getTime() - OFFLINE_CLOCK_SKEW_MS &&
    t <= now.getTime() + OFFLINE_CLOCK_SKEW_MS
  );
}
