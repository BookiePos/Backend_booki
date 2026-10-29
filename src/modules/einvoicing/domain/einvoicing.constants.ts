/**
 * Tipo de documento electrónico: factura, documento equivalente POS, notas
 * crédito/débito y nómina electrónica (con su ajuste).
 */
export const DOC_TYPES = [
  "invoice",
  "pos",
  "credit_note",
  "debit_note",
  "payroll",
  "payroll_adjustment",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/**
 * Estado ante la DIAN. `draft` (generado) → `signed` (firmado con el .p12) →
 * `sent` (transmitido, en vuelo) → `accepted` | `rejected`; `contingency` es
 * la salida cuando la DIAN no responde. Solo `esVeredictoDian()` (ver
 * `estado-dian.ts`) puede escribir `rejected`. El antiguo `pending` pasó a `sent`.
 */
export const DIAN_STATUS = [
  "draft",
  "signed",
  "sent",
  "accepted",
  "rejected",
  "contingency",
] as const;
export type DianStatus = (typeof DIAN_STATUS)[number];

/**
 * Medio de pago (subconjunto de códigos DIAN). El POS es de contado.
 * 10 = efectivo, 48 = tarjeta crédito, 49 = tarjeta débito, 42 = transferencia.
 */
export const MEDIO_PAGO_BY_METHOD: Record<string, string> = {
  cash: "10",
  card: "48",
  transfer: "42",
};

/** Ambiente DIAN: 1 = producción, 2 = pruebas/habilitación. Sin PT: pruebas. */
export const TIPO_AMBIENTE = "2";

/** Unidad de medida por defecto (94 = unidad, catálogo DIAN). */
export const UNIT_CODE = "94";

/** NIT del consumidor final cuando la venta no identifica adquiriente. */
export const CONSUMIDOR_FINAL_NIT = "222222222222";
