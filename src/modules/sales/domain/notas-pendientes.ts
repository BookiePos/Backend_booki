/**
 * Qué notas de una venta con documento de contingencia siguen pendientes de
 * transcribir. Una sola regla para quien las emite (`ContingenciaVentasService`)
 * y para quien las cuenta, así el conteo que ve la pantalla es el que el
 * reintento va a procesar.
 *
 * Dominio puro: sin Nest ni Mongoose.
 */

/** Filtro de las devoluciones y rebajas cuya nota todavía no se emitió. */
export const FILTRO_RETORNO_SIN_NOTA = { 'notaFiscal.estado': { $ne: 'emitida' } } as const;

/** Una venta anulada cuya nota de anulación todavía no se emitió (va al final, tras las demás). */
export function anulacionSinNota(sale: { status?: string; notaAnulacion?: { estado?: string } }): boolean {
  return sale.status === 'void' && sale.notaAnulacion?.estado !== 'emitida';
}
