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

/**
 * Para el CONTEO que ve la pantalla: además de las emitidas, `sin_nota` es un
 * resultado final (devolución sin valor, referido rechazado), no algo que un
 * reintento vaya a emitir. Si contara, el número nunca bajaría a 0. El filtro
 * del reintento (`FILTRO_RETORNO_SIN_NOTA`) no cambia.
 */
export const FILTRO_RETORNO_POR_CONTAR = { 'notaFiscal.estado': { $nin: ['emitida', 'sin_nota'] } } as const;

/** Anulación pendiente para el conteo expuesto: ni emitida ni resuelta sin nota. */
export function anulacionPorContar(sale: { status?: string; notaAnulacion?: { estado?: string } }): boolean {
  return sale.status === 'void' && sale.notaAnulacion?.estado !== 'emitida' && sale.notaAnulacion?.estado !== 'sin_nota';
}
