/** Tipo de documento electrónico. */
export const DOC_TYPES = ['invoice', 'credit_note'] as const;
export type DocType = (typeof DOC_TYPES)[number];

/**
 * Estado ante la DIAN.
 *
 * - `draft`     heredado: documentos de antes de la integración, que nunca se
 *               enviaron. No se crean más.
 * - `pending`   reservado y por confirmar (enviando, DIAN caída, reintentando).
 * - `accepted`  validado por la DIAN: es factura legalmente.
 * - `rejected`  la DIAN (o el facturador) lo rechazó. Se corrige y se reenvía
 *               con el MISMO número.
 * - `failed`    no se pudo enviar por configuración (certificado vencido,
 *               conexión sin configurar). Se reenvía al arreglarla.
 */
export const DIAN_STATUS = [
  'draft',
  'pending',
  'accepted',
  'rejected',
  'failed',
] as const;
export type DianStatus = (typeof DIAN_STATUS)[number];

/**
 * Medio de pago (subconjunto de códigos DIAN). El POS es de contado.
 * 10 = efectivo, 48 = tarjeta crédito, 47 = transferencia débito bancaria.
 */
export const MEDIO_PAGO_BY_METHOD: Record<string, string> = {
  cash: '10',
  card: '48',
  transfer: '47',
};

/** NIT del consumidor final cuando la venta no identifica adquiriente. */
export const CONSUMIDOR_FINAL_NIT = '222222222222';

/** Prefijo de las notas crédito (numeración propia, sin resolución DIAN). */
export const CREDIT_NOTE_PREFIX = 'NC';

/** Rango de numeración de las notas crédito: lo escoge el emisor. */
export const CREDIT_NOTE_RANGE = { from: 1, to: 99_999_999 } as const;

/** Ambiente DIAN de una empresa. */
export const EINVOICE_ENVIRONMENTS = ['habilitacion', 'produccion'] as const;
export type EinvoiceEnvironmentName = (typeof EINVOICE_ENVIRONMENTS)[number];

/**
 * Pasos de la habilitación, en orden. El asistente avanza por ellos y se puede
 * retomar donde quedó.
 */
export const ACCOUNT_STEPS = [
  'empresa', // falta crear la empresa en el facturador
  'certificado', // falta el certificado digital
  'software', // falta el ID y PIN del software propio
  'set_pruebas', // falta pasar el set de pruebas de la DIAN
  'produccion', // habilitada y emitiendo en producción
] as const;
export type AccountStep = (typeof ACCOUNT_STEPS)[number];

/**
 * Reintentos de un documento pendiente: espera creciente para no golpear a la
 * DIAN cuando está caída. Tras el último, queda pendiente hasta que alguien lo
 * reenvíe a mano.
 */
export const RETRY_DELAYS_MS = [
  60_000, // 1 min
  5 * 60_000, // 5 min
  15 * 60_000, // 15 min
  60 * 60_000, // 1 h
  3 * 60 * 60_000, // 3 h
  12 * 60 * 60_000, // 12 h
] as const;
