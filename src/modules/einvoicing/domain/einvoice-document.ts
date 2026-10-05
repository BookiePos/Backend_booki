/**
 * Documento electrónico en la forma que BookiPos le entrega a un proveedor.
 *
 * Es la frontera entre BookiPos y quien firma y transmite a la DIAN (hoy
 * APIDIAN). El servicio arma esto desde la venta o la factura; cada proveedor
 * lo traduce a su propio JSON. Así el resto del código no sabe con quién habla
 * y cambiar de proveedor es escribir otro traductor.
 *
 * Los importes van como en el POS: precios CON impuesto incluido, y la base y
 * el impuesto de cada línea ya discriminados.
 *
 * Dominio puro: sin Nest ni Mongoose.
 */

/** Impuesto de una línea. `none` = la línea no lleva tributo (excluido). */
export type EinvoiceTaxKind = 'iva' | 'inc' | 'none';

export interface EinvoiceLine {
  code: string;
  description: string;
  qty: number;
  /** Bruto de la línea antes de descuentos, impuesto incluido. */
  grossTotal: number;
  /** Base gravable final de la línea (sin impuesto, tras descuentos). */
  base: number;
  taxKind: EinvoiceTaxKind;
  /** Tarifa en porcentaje (19, 5, 8, 0). */
  taxRate: number;
  taxAmount: number;
}

/** Datos del emisor (la sede/NIT que factura). */
export interface EinvoiceIssuer {
  nit: string;
  dv?: string;
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  departamento?: string;
  ciudad?: string;
}

/** Adquiriente. Sin documento = consumidor final. */
export interface EinvoiceCustomer {
  /** Código DIAN del tipo de documento (13 = CC, 31 = NIT…). */
  docType?: string;
  docNumber?: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export interface EinvoiceDocument {
  /** La nota débito solo la usa el set de pruebas de la DIAN. */
  kind: 'invoice' | 'credit_note' | 'debit_note';
  prefix: string;
  number: number;
  /** Número de la resolución DIAN (solo facturas). */
  resolutionNumber?: string;
  /** YYYY-MM-DD, hora Colombia. */
  issueDate: string;
  /** HH:MM:SS, hora Colombia. */
  issueTime: string;
  issuer: EinvoiceIssuer;
  customer: EinvoiceCustomer;
  lines: EinvoiceLine[];
  /** Método de cobro del POS (cash, card, transfer, credit). */
  paymentMethod?: string;
  /** Propina voluntaria: va como cargo, fuera de la base gravable. */
  tip: number;
  notes?: string;
  /** Nota crédito o débito: la factura que corrige y por qué. */
  reference?: { fullNumber: string; cufe: string; issueDate: string };
  reason?: string;
}
