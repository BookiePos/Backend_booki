import { cop, sumCop } from '../../finance/domain/money.util';

export interface TotalesComanda {
  /** Consumo con el INC incluido, como está en la carta. */
  subtotal: number;
  /** Parte del consumo que es INC (ya incluida, no se suma). */
  incAmount: number;
  tipAmount: number;
  /** Lo que se paga: consumo + propina. */
  total: number;
}

/**
 * Totales de la precuenta. El precio de la carta incluye el INC, igual que lo
 * cobra el POS (`saleTaxFor`), así que el INC se desglosa y no se suma. La
 * propina sugerida es un porcentaje del consumo y sí va encima.
 */
export function totalesDeComanda(
  items: { unitPrice: number; qty: number }[],
  incRate: number,
  tipRate: number,
  tipAccepted: boolean,
): TotalesComanda {
  const subtotal = sumCop(items.map((i) => cop(i.unitPrice * i.qty)));
  const incAmount = cop(subtotal - subtotal / (1 + incRate / 100));
  const tipAmount = tipAccepted ? cop((subtotal * tipRate) / 100) : 0;
  return { subtotal, incAmount, tipAmount, total: subtotal + tipAmount };
}
