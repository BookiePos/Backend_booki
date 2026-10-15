/**
 * Repartos de dinero de la venta, en COP entero (ítem 1.11).
 *
 * Todos usan la misma técnica: REDONDEO ACUMULADO. Cada parte es la diferencia
 * entre el acumulado redondeado hasta ella y el acumulado redondeado anterior.
 * Así la última parte cierra con el residuo y la suma de las partes es EXACTO
 * el total repartido. A diferencia de redondear cada parte y cargarle a la
 * última "lo que sobre", ninguna parte queda negativa ni se pasa de su peso
 * (con pesos enteros): la última línea de $1 no puede llevarse −$1 de descuento.
 */
import { cop } from '../../finance/domain/money.util';

/**
 * Reparte `total` (COP entero) en proporción a `weights`. Las partes son
 * enteras y suman exacto `total`; el residuo lo absorbe la última línea.
 */
export function prorateCop(total: number, weights: readonly number[]): number[] {
  const sumW = weights.reduce((s, w) => s + Math.max(w, 0), 0);
  if (sumW <= 0) return weights.map(() => 0);
  const out: number[] = [];
  let acumW = 0;
  let asignado = 0;
  for (const w of weights) {
    acumW += Math.max(w, 0);
    const hasta = cop((total * acumW) / sumW);
    out.push(hasta - asignado);
    asignado = hasta;
  }
  return out;
}

/**
 * Separa base e impuesto de un neto con impuesto INCLUIDO (IVA o INC), en
 * pesos. El impuesto es el residuo, así `base + tax === net` siempre.
 */
export function splitTaxIncluded(
  net: number,
  rate: number,
): { base: number; tax: number } {
  const n = cop(net);
  const base = rate > 0 ? cop(n / (1 + rate / 100)) : n;
  return { base, tax: n - base };
}

/**
 * Cuánto vale cobrar `qty` de una línea de la que ya se cobraron `priorQty`.
 *
 * En la cuenta dividida cada cobro lleva una fracción de la cantidad (0,333 de
 * una pizza). Redondeando cada cobro por su cuenta, tres tercios de $10.001
 * sumaban $10.000. Con el acumulado, lo cobrado en todos los pagos suma exacto
 * `cop(unitPrice × qty total)`.
 */
export function chargeForQty(
  unitPrice: number,
  priorQty: number,
  qty: number,
): number {
  return cop(unitPrice * (priorQty + qty)) - cop(unitPrice * priorQty);
}
