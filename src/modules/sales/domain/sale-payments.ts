import { cop } from '../../finance/domain/money.util';
import {
  CARD_FRANCHISES,
  CARD_TYPES,
  CHANNEL_METHOD,
  CardFranchise,
  CardType,
  PaymentChannel,
  PaymentMethod,
  REFERENCE_PATTERN,
} from './sales.constants';

/** Detalle del canal digital (ítem 6.4); todo opcional. */
export interface PaymentDetail {
  channel?: PaymentChannel;
  /** Solo datáfono. */
  cardType?: CardType;
  /** Solo datáfono. */
  franchise?: CardFranchise;
  /** Aprobación / últimos 4 / número de la billetera. */
  reference?: string;
}

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

export interface SalePaymentPart extends PaymentDetail {
  method: PaymentMethod;
  /** Monto neto que ese medio cubrió (el efectivo, sin el vuelto). */
  amount: number;
}

/** Una parte tal como llega del POS. En efectivo, `amount` es lo recibido. */
export interface IncomingPaymentPart extends PaymentDetail {
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
  /** Detalle del canal cuando el cobro entero fue una sola parte digital. */
  primaryDetail?: PaymentDetail;
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
  // Una entrada por (medio, canal, tipo, franquicia): dos Nequi se juntan,
  // un Nequi y un Daviplata no.
  const byKey = new Map<string, SalePaymentPart>();
  let credits = 0;
  for (const p of incoming) {
    const amount = cop(p.amount);
    if (!(amount > 0)) {
      throw new SplitPaymentError('Cada medio de pago tiene que llevar un monto mayor que cero');
    }
    if (p.method === 'credit') credits += 1;
    const detail = normalizeDetail(p);
    const key = [p.method, detail.channel, detail.cardType, detail.franchise].join('|');
    const prev = byKey.get(key);
    if (prev) {
      prev.amount += amount;
      if (detail.reference && prev.reference !== detail.reference) {
        prev.reference = [prev.reference, detail.reference].filter(Boolean).join(' / ').slice(0, 120);
      }
    } else {
      byKey.set(key, { method: p.method, amount, ...detail });
    }
  }
  const byMethod = new Map<PaymentMethod, number>();
  for (const part of byKey.values()) {
    byMethod.set(part.method, (byMethod.get(part.method) ?? 0) + part.amount);
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
  const parts: SalePaymentPart[] = [...byKey.values()]
    .map((part) => ({
      ...part,
      amount: part.method === 'cash' ? part.amount - change : part.amount,
    }))
    // Un efectivo que solo era vuelto (pagó todo con tarjeta y además dio
    // billetes) no es una parte del cobro.
    .filter((p) => p.amount > 0);

  // Ante un empate gana el que llegó primero. Un cobro de $0 no deja partes:
  // el medio es el primero que se mandó.
  // El medio principal suma todas las partes de ese medio (30 Nequi + 30
  // Daviplata + 40 efectivo -> transferencia).
  const totals = new Map<PaymentMethod, number>();
  for (const p of parts) totals.set(p.method, (totals.get(p.method) ?? 0) + p.amount);
  let primaryMethod: PaymentMethod = parts[0]?.method ?? incoming[0]!.method;
  let best = parts[0] ? (totals.get(parts[0].method) ?? 0) : 0;
  for (const [m, t] of totals) {
    if (t > best) {
      best = t;
      primaryMethod = m;
    }
  }
  const only = parts.length === 1 ? parts[0] : undefined;
  const primaryDetail = only ? detailOf(only) : undefined;

  return {
    parts,
    cashReceived: cash,
    change,
    creditAmount,
    primaryMethod,
    primaryDetail,
  };
}

/** Valida y limpia el detalle de un canal digital. */
export function normalizeDetail(p: { method: PaymentMethod } & PaymentDetail): PaymentDetail {
  const out: PaymentDetail = {};
  const reference = p.reference?.trim();
  if (reference && !REFERENCE_PATTERN.test(reference)) {
    throw new SplitPaymentError(
      'La referencia solo admite letras, números, espacios y . - / # * (máx. 40)',
    );
  }
  if (p.channel) {
    if (CHANNEL_METHOD[p.channel] !== p.method) {
      throw new SplitPaymentError(
        `El canal ${p.channel} se cobra como ${CHANNEL_METHOD[p.channel]}, no como ${p.method}`,
      );
    }
    out.channel = p.channel;
  }
  if (p.cardType || p.franchise) {
    if (p.channel !== 'datafono') {
      throw new SplitPaymentError('El tipo de tarjeta y la franquicia solo aplican al datáfono');
    }
    if (p.cardType) {
      if (!(CARD_TYPES as readonly string[]).includes(p.cardType)) {
        throw new SplitPaymentError('Tipo de tarjeta inválido');
      }
      out.cardType = p.cardType;
    }
    if (p.franchise) {
      if (!(CARD_FRANCHISES as readonly string[]).includes(p.franchise)) {
        throw new SplitPaymentError('Franquicia inválida');
      }
      out.franchise = p.franchise;
    }
  }
  if (reference) {
    if (p.method !== 'card' && p.method !== 'transfer') {
      throw new SplitPaymentError('La referencia solo aplica a pagos digitales');
    }
    out.reference = reference;
  }
  return out;
}

/** El detalle (sin monto ni medio) de una parte, sin claves vacías. */
export function detailOf(p: PaymentDetail): PaymentDetail | undefined {
  const d: PaymentDetail = {};
  if (p.channel) d.channel = p.channel;
  if (p.cardType) d.cardType = p.cardType;
  if (p.franchise) d.franchise = p.franchise;
  if (p.reference) d.reference = p.reference;
  return Object.keys(d).length > 0 ? d : undefined;
}

/** Lo mínimo de una venta que hace falta para saber cómo se pagó. */
export interface SalePaymentsView {
  total: number;
  tip?: number;
  deliveryFee?: number;
  payment?: ({ method?: string } & PaymentDetail) | null;
  payments?: readonly ({ method: string; amount: number } & PaymentDetail)[] | null;
}

/** Parte de una venta tal como la lee `salePartsOf`. */
export type SaleReadPart = { method: string; amount: number } & PaymentDetail;

/**
 * Cómo se pagó una venta, parte por parte. Las ventas de antes del ítem 6.9 (y
 * las de un solo medio) no traen `payments`: su único medio cubrió todo lo
 * cobrado.
 */
export function salePartsOf(sale: SalePaymentsView): SaleReadPart[] {
  if (sale.payments && sale.payments.length > 0) {
    return sale.payments.map((p) => ({ method: p.method, amount: p.amount, ...detailOf(p) }));
  }
  const method = sale.payment?.method ?? 'cash';
  return [
    {
      method,
      amount: cop(sale.total + (sale.tip ?? 0) + (sale.deliveryFee ?? 0)),
      ...detailOf(sale.payment ?? {}),
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
export function treasurySourceId(
  saleId: string,
  method: string,
  mixed: boolean,
  detail?: PaymentDetail,
): string {
  if (!mixed) return saleId;
  // Con canal (ítem 6.4) varias partes comparten medio: el canal las distingue.
  // Sin canal queda `${saleId}:${method}`, como siempre.
  if (!detail?.channel) return `${saleId}:${method}`;
  return [saleId, detail.channel, detail.cardType, detail.franchise].filter(Boolean).join(':');
}

/** Todos los `sourceId` de tesorería que una venta pudo dejar (para anularla). */
export function treasurySourceIds(saleId: string): string[] {
  return [saleId, `${saleId}:card`, `${saleId}:transfer`];
}
