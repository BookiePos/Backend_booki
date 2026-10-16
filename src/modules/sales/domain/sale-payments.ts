import { cop } from '../../finance/domain/money.util';
import { PaymentMethod } from './sales.constants';

/**
 * Pagos mixtos en un tiquete (ítem 6.9): efectivo + tarjeta, etc., sin
 * dividir la cuenta.
 *
 * Reglas:
 *   - La suma de las partes tiene que cubrir lo que se cobra: total + propina
 *     + domicilio.
 *   - El vuelto solo sale del efectivo: lo que no es efectivo no puede pasarse
 *     del total, y lo que sobra se le devuelve al cliente del efectivo.
 *   - El fiado (cliente o empleado) puede ser UNA de las partes, y solo una:
 *     su deudor es uno. No se fía la propina (es del personal), así que la
 *     parte fiada no puede pasar de total + domicilio.
 *   - Dos partes del mismo medio (dos pagos con tarjeta) se juntan en una.
 *
 * Lo que se guarda en la venta es el monto NETO de cada medio: el efectivo ya
 * sin el vuelto. Así la suma de las partes es exactamente lo cobrado y cada
 * pieza (asiento, tesorería, arqueo) lee lo que de verdad le entró.
 */

export interface SalePaymentPart {
  method: PaymentMethod;
  /** Monto neto que ese medio cubrió (el efectivo, sin el vuelto). */
  amount: number;
}

/** Una parte tal como llega del POS. En efectivo, `amount` es lo recibido. */
export interface IncomingPaymentPart {
  method: PaymentMethod;
  amount: number;
}

export interface SplitPaymentResult {
  /** Partes netas, una por medio, en el orden en que llegaron. */
  parts: SalePaymentPart[];
  /** Efectivo entregado por el cliente (antes del vuelto). */
  cashReceived: number;
  /** Vuelto: siempre sale del efectivo. */
  change: number;
  /** Lo que se fía: la parte a crédito (0 si no hay). */
  creditAmount: number;
  /** Medio que más cubrió: es el que queda en `payment.method`. */
  primaryMethod: PaymentMethod;
}

/** Error de validación del reparto (el servicio lo traduce a 400). */
export class SplitPaymentError extends Error {}

/**
 * Valida y normaliza el reparto de un cobro mixto.
 *
 * @param due       lo que se cobra: total + propina + domicilio.
 * @param creditCap lo máximo que se puede fiar: total + domicilio.
 */
export function splitPayment(
  incoming: readonly IncomingPaymentPart[],
  due: number,
  creditCap: number,
): SplitPaymentResult {
  if (incoming.length === 0) {
    throw new SplitPaymentError('El cobro necesita al menos un medio de pago');
  }
  const byMethod = new Map<PaymentMethod, number>();
  let credits = 0;
  for (const p of incoming) {
    const amount = cop(p.amount);
    if (!(amount > 0)) {
      throw new SplitPaymentError('Cada medio de pago tiene que llevar un monto mayor que cero');
    }
    if (p.method === 'credit') credits += 1;
    byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + amount);
  }
  if (credits > 1) {
    throw new SplitPaymentError('Solo una parte del cobro puede ser fiada');
  }

  const dueCop = cop(due);
  const cash = byMethod.get('cash') ?? 0;
  const nonCash = [...byMethod.entries()]
    .filter(([m]) => m !== 'cash')
    .reduce((a, [, v]) => a + v, 0);
  const sum = cash + nonCash;

  if (sum < dueCop) {
    throw new SplitPaymentError(
      `Los pagos suman $${sum} y el cobro es de $${dueCop} (incluye propina y domicilio): faltan $${dueCop - sum}`,
    );
  }
  if (nonCash > dueCop) {
    throw new SplitPaymentError(
      'Lo pagado con tarjeta, transferencia o fiado no puede pasarse del total: el vuelto solo sale del efectivo',
    );
  }
  const creditAmount = byMethod.get('credit') ?? 0;
  if (creditAmount > cop(creditCap)) {
    throw new SplitPaymentError(
      'La propina no se fía: la parte fiada no puede pasar del total más el domicilio',
    );
  }

  const change = sum - dueCop;
  const parts: SalePaymentPart[] = [...byMethod.entries()]
    .map(([method, amount]) => ({
      method,
      amount: method === 'cash' ? amount - change : amount,
    }))
    // Un efectivo que solo era vuelto (pagó todo con tarjeta y además dio
    // billetes) no es una parte del cobro.
    .filter((p) => p.amount > 0);

  // Ante un empate gana el que llegó primero. Un cobro de $0 no deja partes:
  // el medio es el primero que se mandó.
  let primaryMethod: PaymentMethod = parts[0]?.method ?? incoming[0]!.method;
  let best = parts[0]?.amount ?? 0;
  for (const p of parts) {
    if (p.amount > best) {
      best = p.amount;
      primaryMethod = p.method;
    }
  }

  return {
    parts,
    cashReceived: cash,
    change,
    creditAmount,
    primaryMethod,
  };
}

/** Lo mínimo de una venta que hace falta para saber cómo se pagó. */
export interface SalePaymentsView {
  total: number;
  tip?: number;
  deliveryFee?: number;
  payment?: { method?: string } | null;
  payments?: readonly { method: string; amount: number }[] | null;
}

/**
 * Cómo se pagó una venta, parte por parte. Las ventas de antes del ítem 6.9 (y
 * las de un solo medio) no traen `payments`: su único medio cubrió todo lo
 * cobrado.
 */
export function salePartsOf(sale: SalePaymentsView): { method: string; amount: number }[] {
  if (sale.payments && sale.payments.length > 0) {
    return sale.payments.map((p) => ({ method: p.method, amount: p.amount }));
  }
  const method = sale.payment?.method ?? 'cash';
  return [
    {
      method,
      amount: cop(sale.total + (sale.tip ?? 0) + (sale.deliveryFee ?? 0)),
    },
  ];
}

/** Efectivo NETO que la venta dejó en el cajón (sin el vuelto). */
export function cashAmountOf(sale: SalePaymentsView): number {
  return salePartsOf(sale)
    .filter((p) => p.method === 'cash')
    .reduce((a, p) => a + p.amount, 0);
}

/** ¿Alguna parte de la venta fue fiada? */
export function hasCreditPart(sale: SalePaymentsView): boolean {
  return salePartsOf(sale).some((p) => p.method === 'credit');
}

/**
 * `sourceId` del movimiento de tesorería de una venta. La venta de un solo
 * medio usa el id de la venta, como siempre. En un cobro mixto cada medio
 * bancario lleva el suyo, porque tesorería admite un solo movimiento
 * automático por (sourceType, sourceId).
 */
export function treasurySourceId(saleId: string, method: string, mixed: boolean): string {
  return mixed ? `${saleId}:${method}` : saleId;
}

/** Todos los `sourceId` de tesorería que una venta pudo dejar (para anularla). */
export function treasurySourceIds(saleId: string): string[] {
  return [saleId, `${saleId}:card`, `${saleId}:transfer`];
}
