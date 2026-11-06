/**
 * Rebaja o descuento POSTERIOR sobre una venta ya cobrada (Fase 6C;
 * `documentacion/fe-fase6-notas.md` §2.1 y §4).
 *
 * Se le reconoce al cliente un menor valor SIN que vuelva mercancía: una queja
 * del servicio, un descuento que se olvidó al cobrar, un error de precio, el
 * pronto pago de un fiado o el descuento por volumen de un cliente frecuente.
 * No mueve inventario ni costo; baja el ingreso (4175) y el IVA/INC en la
 * misma proporción en que se causaron.
 *
 * El tope es lo que el cliente pagó de verdad por cada producto y todavía
 * conserva: lo pagado (base + impuesto, ya neto de los descuentos del cobro)
 * menos lo devuelto y lo ya rebajado. Así devoluciones y rebajas, sumadas,
 * nunca devuelven más de lo que entró.
 *
 * Dominio puro: sin Nest ni Mongoose. Todo en COP entero.
 */
import { clampNonNegative, cop, sumBy } from '../../finance/domain/money.util';
import { prorateCop } from './sale-amounts';

/**
 * Conceptos de la rebaja (DiscrepancyResponse de la nota): 3 rebaja o
 * descuento, 4 ajuste de precio, 5 descuento comercial por pronto pago y
 * 6 por volumen. El 5 y el 6 solo existen en la NC de la FEV (anexo 1.9,
 * tabla 13.2.4); la nota de ajuste del POS no los tiene (anexo DE §16.6).
 */
export const CONCEPTOS_REBAJA = ['3', '4', '5', '6'] as const;
export type ConceptoRebaja = (typeof CONCEPTOS_REBAJA)[number];

/** Conceptos que la nota de ajuste del POS no admite. */
export const CONCEPTOS_SOLO_FEV: readonly ConceptoRebaja[] = ['5', '6'];

/** Cómo se le reconoce la rebaja al cliente (lo fiado baja primero la CxC). */
export const REBATE_METHODS = ['cash', 'transfer', 'credit_note'] as const;
export type RebateMethod = (typeof REBATE_METHODS)[number];

/** Rebaja inválida: quien llama la vuelve 400. */
export class RebajaInvalidaError extends Error {}

/** Lo vendido de un producto, agrupado (base e impuesto ya netos del descuento). */
export interface ProductoVendido {
  productId: string;
  qty: number;
  taxBase: number;
  taxAmount: number;
}

/** Lo que ya salió de un producto: devuelto (con su impuesto) y rebajado. */
export interface YaReconocido {
  refund: number;
  refundTax: number;
  rebated: number;
  rebatedTax: number;
}

export interface LineaRebaja {
  productId: string;
  /** Lo rebajado, con impuesto. */
  amount: number;
  /** Impuesto incluido en `amount`. */
  tax: number;
}

/** Lo que queda de un producto para rebajar: valor e impuesto. */
export function saldoRebajable(
  vendidos: readonly ProductoVendido[],
  ya: ReadonlyMap<string, YaReconocido>,
): Map<string, { valor: number; impuesto: number }> {
  const out = new Map<string, { valor: number; impuesto: number }>();
  for (const v of vendidos) {
    const prev = out.get(v.productId) ?? { valor: 0, impuesto: 0 };
    out.set(v.productId, {
      valor: prev.valor + cop(v.taxBase + v.taxAmount),
      impuesto: prev.impuesto + cop(v.taxAmount),
    });
  }
  for (const [productId, s] of out) {
    const y = ya.get(productId);
    if (!y) continue;
    s.valor = clampNonNegative(s.valor - y.refund - y.rebated);
    s.impuesto = Math.min(clampNonNegative(s.impuesto - y.refundTax - y.rebatedTax), s.valor);
  }
  return out;
}

/**
 * Arma la rebaja: por producto (`porProducto`) o un monto total (`total`) que
 * se reparte en proporción a lo que queda de cada producto. El impuesto de
 * cada parte sale de la proporción que queda de ese producto, así una línea
 * con INC devuelve INC y una excluida no devuelve impuesto.
 *
 * Lanza `RebajaInvalidaError` si algo pasa de su saldo o no está en la venta.
 */
export function planDeRebaja(
  vendidos: readonly ProductoVendido[],
  ya: ReadonlyMap<string, YaReconocido>,
  pedido: { total?: number; porProducto?: readonly { productId: string; amount: number }[] },
): { lines: LineaRebaja[]; amount: number; tax: number } {
  const saldo = saldoRebajable(vendidos, ya);
  const tieneTotal = pedido.total !== undefined;
  const tieneLineas = (pedido.porProducto ?? []).length > 0;
  if (tieneTotal === tieneLineas) {
    throw new RebajaInvalidaError('Indica el monto total de la rebaja o el monto por producto, no los dos.');
  }

  let pedidas: { productId: string; amount: number }[];
  if (tieneTotal) {
    const total = cop(pedido.total!);
    if (!(total > 0)) throw new RebajaInvalidaError('La rebaja tiene que ser mayor que cero.');
    const disponible = sumBy([...saldo.values()], (s) => s.valor);
    if (total > disponible) {
      throw new RebajaInvalidaError(
        `La rebaja ($${total}) pasa de lo que queda por rebajar en la venta ($${disponible}).`,
      );
    }
    const ids = [...saldo.keys()];
    const partes = prorateCop(total, ids.map((id) => saldo.get(id)!.valor));
    pedidas = ids.map((productId, i) => ({ productId, amount: partes[i]! })).filter((p) => p.amount > 0);
  } else {
    const agrupadas = new Map<string, number>();
    for (const p of pedido.porProducto!) {
      const amount = cop(p.amount);
      if (!(amount > 0)) throw new RebajaInvalidaError('Cada producto rebajado tiene que llevar un monto mayor que cero.');
      agrupadas.set(p.productId, (agrupadas.get(p.productId) ?? 0) + amount);
    }
    pedidas = [...agrupadas].map(([productId, amount]) => ({ productId, amount }));
  }

  const lines = pedidas.map((p) => {
    const s = saldo.get(p.productId);
    if (!s) throw new RebajaInvalidaError('Ese producto no estaba en la venta.');
    if (p.amount > s.valor) {
      throw new RebajaInvalidaError(
        `La rebaja de un producto ($${p.amount}) pasa de lo que queda por rebajar de él ($${s.valor}).`,
      );
    }
    // Impuesto en la proporción que queda; la rebaja que agota el saldo se
    // lleva exacto el impuesto que quedaba (sin pesos colgando).
    const tax =
      p.amount === s.valor ? s.impuesto : Math.min(cop((p.amount * s.impuesto) / s.valor), s.impuesto);
    return { productId: p.productId, amount: p.amount, tax };
  });
  return { lines, amount: sumBy(lines, (l) => l.amount), tax: sumBy(lines, (l) => l.tax) };
}
