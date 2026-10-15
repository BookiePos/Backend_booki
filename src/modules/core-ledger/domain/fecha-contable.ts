/**
 * Fecha contable (YYYY-MM-DD) en Colombia. `toLocaleDateString` sin zona usa
 * la del servidor: en Vercel (UTC) lo vendido después de las 7 p. m. caía al
 * día siguiente, y el último día del mes, en el mes siguiente.
 */
export function fechaColombia(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

/**
 * Fecha del contra-asiento (checklist 1.13).
 *
 * - Original del MISMO mes que hoy: lleva la fecha del original, y la
 *   operación desaparece del mes (el mes sigue abierto).
 * - Original de un mes ANTERIOR: lleva la fecha de hoy. El libro se lleva en
 *   orden cronológico (C. Co. art. 57 num. 1) y la anulación o devolución se
 *   reconoce en el período en que ocurre (E.T. art. 484; NIIF Pymes 10.19-10.22:
 *   corregir un período anterior no es reescribirlo). El memo deja el número y
 *   la fecha del original.
 * - Original con fecha posterior a hoy (un gasto programado): su propia fecha;
 *   no hay reversa antes de que exista lo reversado.
 * - `pedida` (POST /ledger/entries/:id/reverse): YYYY-MM-DD entre la fecha del
 *   original y hoy, ambas incluidas.
 *
 * Pendiente a futuro: no hay CIERRE DE PERÍODO. Nada impide hoy postear con
 * fecha de un mes ya declarado (un asiento manual, un gasto con fecha vieja);
 * el cierre debería bloquear esas fechas y mandar todo ajuste al período
 * abierto.
 */
export function fechaDeReversa(
  original: string,
  hoy: string,
  pedida?: string,
): { fecha: string } | { error: string } {
  if (pedida !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pedida)) {
      return { error: 'La fecha de la reversa debe ser YYYY-MM-DD' };
    }
    if (pedida < original) {
      return { error: `La reversa no puede ser anterior al asiento original (${original})` };
    }
    if (pedida > hoy) return { error: 'La reversa no puede tener fecha futura' };
    return { fecha: pedida };
  }
  if (original.slice(0, 7) === hoy.slice(0, 7) || original > hoy) {
    return { fecha: original };
  }
  return { fecha: hoy };
}
