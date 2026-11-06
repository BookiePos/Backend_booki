import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import type { DocumentoFiscalSolicitado, EstadoDocumentoFiscal } from './documento-fiscal';

/**
 * Ventana para ANULAR una venta con documento equivalente POS (decisión 6 del
 * dueño, 2026-11-06, tarea 13).
 *
 * Un POS solo se anula dentro de la MISMA semana calendario de la venta, de
 * lunes a domingo en hora de Colombia. Después, la venta ya no se anula: se
 * registra una devolución, que emite la nota de ajuste crédito (94) con
 * referencia al CUDE. La FEV no tiene esta ventana (se corrige con su nota
 * crédito en cualquier momento).
 *
 * Dominio puro: sin Nest ni Mongoose.
 */

export const MENSAJE_FUERA_DE_SEMANA_POS =
  'El documento POS de esta venta es de una semana anterior: ya no se puede anular. Registra una devolución por lo que vuelve; esa devolución emite la nota de ajuste del POS.';

/** Lunes (YYYY-MM-DD) de la semana de una fecha YYYY-MM-DD. */
function lunesDe(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  const desdeLunes = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - desdeLunes);
  return d.toISOString().slice(0, 10);
}

/** ¿`a` y `b` caen en la misma semana calendario (lunes a domingo) en Colombia? */
export function mismaSemanaColombia(a: Date, b: Date): boolean {
  return lunesDe(fechaColombia(a)) === lunesDe(fechaColombia(b));
}

/**
 * ¿La venta lleva documento POS? Solo cuenta el que existe o puede existir
 * (`emitido`, `en_proceso`, `pendiente_contingencia_07`); el `error` no dejó
 * documento y la venta se anula como cualquier otra.
 */
export function llevaDocumentoPos(doc?: {
  solicitado?: DocumentoFiscalSolicitado | string;
  estado?: EstadoDocumentoFiscal | string;
  tipo?: string;
} | null): boolean {
  if (!doc) return false;
  if (doc.tipo === 'pos') return true;
  const esPos = doc.solicitado === 'pos_anonimo' || doc.solicitado === 'pos_identificado';
  return esPos && doc.estado !== 'error';
}

/**
 * ¿Se puede anular la venta hoy? Sin POS, siempre. Con POS, solo si `ahora`
 * cae en la misma semana calendario que la venta.
 */
export function puedeAnularPos(
  venta: { fecha: Date; documentoFiscal?: Parameters<typeof llevaDocumentoPos>[0] },
  ahora: Date,
): boolean {
  if (!llevaDocumentoPos(venta.documentoFiscal)) return true;
  return mismaSemanaColombia(venta.fecha, ahora);
}
