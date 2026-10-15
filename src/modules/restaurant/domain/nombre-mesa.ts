/**
 * Cómo se nombra la mesa en la cuenta de caja. La gente llama a sus mesas
 * "Mesa 5", así que anteponer "Mesa" daba "Mesa Mesa 5"; una mesa llamada
 * "Terraza 2" o "5" sí lo necesita.
 */
export function nombreDeMesa(tableName: string): string {
  const nombre = tableName.trim();
  return /^mesa\b/i.test(nombre) ? nombre : `Mesa ${nombre}`;
}
