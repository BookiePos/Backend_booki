/**
 * Utilidades de dinero para Finanzas. Enfoque pragmático: COP entero (sin
 * centavos ni Money/ledger). Aislado aquí para poder migrar a doble partida en
 * el futuro sin tocar el resto del módulo.
 */

/** Redondea a peso entero (COP no usa centavos en caja). */
export function cop(amount: number): number {
  return Math.round(amount || 0);
}

/** Suma una lista de montos, redondeando el resultado a peso entero. */
export function sumCop(amounts: readonly number[]): number {
  return cop(amounts.reduce((a, n) => a + (n || 0), 0));
}

/** Suma tomando un campo numérico de cada elemento. */
export function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  return cop(items.reduce((a, item) => a + (pick(item) || 0), 0));
}

/** Nunca deja un saldo/monto por debajo de 0 (clamp). */
export function clampNonNegative(amount: number): number {
  return amount < 0 ? 0 : cop(amount);
}
