/**
 * "1 cuenta abierta", "3 cuentas abiertas". Los mensajes que lee el dueño o el
 * cajero no llevan "cuenta(s) abierta(s)": el paréntesis obliga a leer dos veces.
 * Se pasa la frase completa en singular y en plural para que concuerde el
 * adjetivo. Los logs internos pueden seguir como están.
 */
export function contar(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString('es-CO')} ${n === 1 ? singular : plural}`;
}
