import { DIAN_HABILITACION_RESOLUTION } from './apidian-catalogs';
import type {
  EinvoiceDocument,
  EinvoiceIssuer,
  EinvoiceLine,
} from './einvoice-document';

/**
 * Set de pruebas de la DIAN para habilitar un facturador con software propio.
 *
 * La DIAN pide, para esta modalidad, 8 facturas, 1 nota crédito y 1 nota
 * débito, enviadas al set (modo asíncrono) con la numeración de pruebas que
 * asigna a todos en habilitación. Cuando las acepta, el facturador queda
 * "Habilitado" en su portal y puede pasar a producción.
 *
 * Las facturas varían a propósito (una tarifa, varias tarifas, descuento,
 * excluido, varias unidades) para que el set ejercite lo mismo que el POS
 * va a mandar después en producción.
 *
 * Dominio puro.
 */

export const TEST_SET_COUNTS = { invoice: 8, credit_note: 1, debit_note: 1 } as const;

export type TestDocKind = 'invoice' | 'credit_note' | 'debit_note';
export type TestDocStatus = 'pending' | 'accepted' | 'rejected';

/** Un documento del set y lo que respondió la DIAN. */
export interface TestSetDoc {
  kind: TestDocKind;
  prefix: string;
  number: number;
  cufe?: string;
  zipKey?: string;
  status: TestDocStatus;
  message?: string;
  errors: string[];
}

/** Prefijos de las notas del set (numeración propia, sin resolución DIAN). */
export const TEST_NOTE_PREFIX = { credit_note: 'NC', debit_note: 'ND' } as const;

const line = (
  code: string,
  description: string,
  qty: number,
  unitGross: number,
  rate: number,
  discount = 0,
): EinvoiceLine => {
  const grossTotal = Math.round(qty * unitGross * 100) / 100;
  const net = grossTotal - discount;
  const base = rate > 0 ? Math.round((net / (1 + rate / 100)) * 100) / 100 : net;
  return {
    code,
    description,
    qty,
    grossTotal,
    base,
    taxKind: 'iva',
    taxRate: rate,
    taxAmount: Math.round((net - base) * 100) / 100,
  };
};

/** Las líneas de cada una de las 8 facturas: casos distintos a propósito. */
const INVOICE_LINES: EinvoiceLine[][] = [
  [line('P01', 'Producto con IVA general', 1, 11_900, 19)],
  [line('P02', 'Producto con IVA reducido', 2, 10_500, 5)],
  [
    line('P01', 'Producto con IVA general', 1, 11_900, 19),
    line('P03', 'Producto exento', 1, 5_000, 0),
  ],
  [line('P04', 'Producto con descuento', 3, 23_800, 19, 7_140)],
  [
    line('P01', 'Producto con IVA general', 2, 11_900, 19),
    line('P02', 'Producto con IVA reducido', 1, 10_500, 5),
  ],
  [line('P05', 'Servicio', 1, 59_500, 19)],
  [line('P06', 'Producto por unidades', 12, 2_380, 19)],
  [
    line('P01', 'Producto con IVA general', 1, 11_900, 19),
    line('P02', 'Producto con IVA reducido', 1, 10_500, 5),
    line('P03', 'Producto exento', 2, 5_000, 0),
  ],
];

/** Las 8 facturas del set, numeradas desde `firstNumber`. */
export function buildTestInvoices(
  issuer: EinvoiceIssuer,
  firstNumber: number,
  issueDate: string,
  issueTime: string,
): EinvoiceDocument[] {
  return INVOICE_LINES.map((lines, i) => ({
    kind: 'invoice',
    prefix: DIAN_HABILITACION_RESOLUTION.prefix,
    number: firstNumber + i,
    resolutionNumber: DIAN_HABILITACION_RESOLUTION.resolutionNumber,
    issueDate,
    issueTime,
    issuer,
    customer: {},
    lines,
    paymentMethod: i % 3 === 0 ? 'card' : 'cash',
    tip: 0,
    notes: 'Set de pruebas DIAN — BookiPos',
  }));
}

/**
 * Nota crédito o débito del set, sobre una factura ya enviada (necesita su
 * CUFE). La crédito anula la factura completa; la débito le suma un cargo.
 */
export function buildTestNote(
  kind: 'credit_note' | 'debit_note',
  invoice: EinvoiceDocument,
  invoiceCufe: string,
  number: number,
  issueDate: string,
  issueTime: string,
): EinvoiceDocument {
  return {
    ...invoice,
    kind,
    prefix: TEST_NOTE_PREFIX[kind],
    number,
    resolutionNumber: undefined,
    issueDate,
    issueTime,
    lines:
      kind === 'credit_note'
        ? invoice.lines
        : [line('AJ1', 'Ajuste de valor', 1, 5_950, 19)],
    reference: {
      fullNumber: `${invoice.prefix}${invoice.number}`,
      cufe: invoiceCufe,
      issueDate: invoice.issueDate,
    },
    reason:
      kind === 'credit_note'
        ? 'Anulación (set de pruebas)'
        : 'Ajuste de valor (set de pruebas)',
  };
}

/** Resumen del set para mostrar en el asistente. */
export function summarizeTestSet(docs: readonly TestSetDoc[]): {
  sent: number;
  accepted: number;
  rejected: number;
  pending: number;
  complete: boolean;
  missing: Record<TestDocKind, number>;
} {
  const accepted = docs.filter((d) => d.status === 'accepted');
  const missing = {
    invoice: Math.max(0, TEST_SET_COUNTS.invoice - accepted.filter((d) => d.kind === 'invoice').length),
    credit_note: Math.max(0, TEST_SET_COUNTS.credit_note - accepted.filter((d) => d.kind === 'credit_note').length),
    debit_note: Math.max(0, TEST_SET_COUNTS.debit_note - accepted.filter((d) => d.kind === 'debit_note').length),
  };
  return {
    sent: docs.length,
    accepted: accepted.length,
    rejected: docs.filter((d) => d.status === 'rejected').length,
    pending: docs.filter((d) => d.status === 'pending').length,
    complete: missing.invoice + missing.credit_note + missing.debit_note === 0,
    missing,
  };
}
