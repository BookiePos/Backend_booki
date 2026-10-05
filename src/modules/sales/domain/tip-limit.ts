/**
 * Tope legal de la propina.
 *
 * Ley 1935 de 2018, art. 3, parágrafo 1: "En ningún caso la propina podrá
 * superar el 10 % del valor del servicio prestado, cuando esta sea sugerida
 * por el establecimiento de comercio e incorporada en la factura con la
 * aceptación del consumidor". BookiPos la incorpora en la factura electrónica,
 * así que el tope aplica siempre.
 *
 * Dominio puro.
 */
export const MAX_TIP_RATE = 0.1;

/**
 * Propina máxima para un consumo. Se redondea HACIA ARRIBA al peso para no
 * rechazar el 10 % exacto que sugiere el propio POS (que redondea al peso).
 */
export function maxTip(consumo: number): number {
  return Math.max(0, Math.ceil(consumo * MAX_TIP_RATE));
}
