/**
 * Tipo de documento electrónico: factura, documento equivalente POS, notas
 * crédito/débito y nómina electrónica (con su ajuste).
 */
export const DOC_TYPES = [
  'invoice',
  'pos',
  'credit_note',
  'debit_note',
  'payroll',
  'payroll_adjustment',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/**
 * Estado ante la DIAN. `draft` (generado) → `signed` (firmado con el .p12) →
 * `sent` (transmitido, en vuelo) → `accepted` | `rejected`; `contingency` es
 * la salida cuando la DIAN no responde. Solo `esVeredictoDian()` (ver
 * `estado-dian.ts`) puede escribir `rejected`. El antiguo `pending` pasó a `sent`.
 */
export const DIAN_STATUS = [
  'draft',
  'signed',
  'sent',
  'accepted',
  'rejected',
  'contingency',
] as const;
export type DianStatus = (typeof DIAN_STATUS)[number];

/**
 * Medio de pago de la FACTURA de venta (subconjunto de códigos DIAN): un solo
 * medio. 10 = efectivo, 48 = tarjeta crédito, 42 = transferencia. El POS usa
 * `pagoPosDian` (uno por parte del cobro).
 */
export const MEDIO_PAGO_BY_METHOD: Record<string, string> = {
  cash: '10',
  card: '48',
  transfer: '42',
};

/**
 * Forma y medio de pago de UNA parte del cobro en el documento equivalente POS
 * (anexo DE v1.0 DEAN01-05; tabla de medios de pago). El POS admite varios
 * `PaymentMeans`: el pago mixto manda uno por parte.
 *
 * - Tarjeta: 49 débito, 48 crédito según `cardType`; sin tipo, 48 (como hoy la
 *   factura).
 * - Transferencia, Nequi, Daviplata y QR: 47 «Transferencia débito bancaria»
 *   (la factura manda 42 «consignación»; a confirmar en el set).
 * - Fiado: forma 2 (crédito) con 1 «Instrumento no definido»: aún no hay medio;
 *   el vencimiento lo pone quien arma los pagos (DEAN04).
 * - Plataforma (Rappi…): ZZZ «Acuerdo mutuo» de contado (a confirmar).
 * - Un método desconocido no se adivina como efectivo: 1.
 */
export function pagoPosDian(p: { method: string; cardType?: string; channel?: string }): {
  formaPago: '1' | '2';
  medio: string;
} {
  switch (p.method) {
    case 'cash':
      return { formaPago: '1', medio: '10' };
    case 'card':
      return { formaPago: '1', medio: p.cardType === 'debit' ? '49' : '48' };
    case 'transfer':
      return { formaPago: '1', medio: '47' };
    case 'credit':
      return { formaPago: '2', medio: '1' };
    case 'platform':
      return { formaPago: '1', medio: 'ZZZ' };
    default:
      return { formaPago: '1', medio: '1' };
  }
}

/** Unidad de medida por defecto (94 = unidad, catálogo DIAN). */
export const UNIT_CODE = '94';

/** NIT del consumidor final cuando la venta no identifica adquiriente. */
export const CONSUMIDOR_FINAL_NIT = '222222222222';
