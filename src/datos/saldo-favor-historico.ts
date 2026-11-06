import { clampNonNegative, cop } from '../modules/finance/domain/money.util';

/**
 * Plan del script `2026-11-saldo-favor-historico` (lógica pura, probada en
 * `saldo-favor-historico.spec.ts`).
 *
 * Antes de la Fase 6C, una devolución o rebaja con `credit_note` (saldo a
 * favor) o `none` (cambio) acreditaba la 2805 sin dejar rastro de a qué
 * cliente. Este plan atribuye cada una a su cliente con el mismo monto que hoy
 * abona `SaleReturnsService.abonarSaldoFavor`: lo reconocido menos lo que bajó
 * la cartera, más la propina devuelta. Las que no se pueden atribuir se
 * informan y no se tocan.
 */

export interface DevolucionHistorica {
  id: string;
  saleId: string;
  refundMethod: string;
  refundTotal: number;
  abonoCartera?: number;
  tipRefund?: number;
  aSaldoFavor?: number;
}

export interface VentaHistorica {
  id: string;
  saleNumber: string;
  customerId?: string;
  /** Documento del cliente congelado en la venta (`sale.customer.idNumber`). */
  docNumber?: string;
  customerName?: string;
}

export interface AbonoPlaneado {
  returnId: string;
  customerId: string;
  customerName?: string;
  amount: number;
  memo: string;
}

export interface PlanSaldoFavor {
  abonos: AbonoPlaneado[];
  /** Ya tienen su abono en el auxiliar (idempotencia). */
  yaAtribuidas: number;
  sinCliente: { returnId: string; saleNumber?: string; amount: number; motivo: string }[];
}

/** Solo dígitos: el documento puede venir con puntos o guion. */
const soloDigitos = (s?: string) => (s ?? '').replace(/\D/g, '');

export function planSaldoFavorHistorico(
  devoluciones: readonly DevolucionHistorica[],
  ventas: ReadonlyMap<string, VentaHistorica>,
  clientesPorDocumento: ReadonlyMap<string, { id: string; name?: string }>,
  yaEnAuxiliar: ReadonlySet<string>,
): PlanSaldoFavor {
  const plan: PlanSaldoFavor = { abonos: [], yaAtribuidas: 0, sinCliente: [] };
  for (const d of devoluciones) {
    if (d.refundMethod !== 'credit_note' && d.refundMethod !== 'none') continue;
    const amount = cop(
      clampNonNegative(d.refundTotal - (d.abonoCartera ?? 0)) + (d.tipRefund ?? 0),
    );
    if (amount <= 0) continue;
    if (yaEnAuxiliar.has(d.id)) {
      plan.yaAtribuidas += 1;
      continue;
    }
    const venta = ventas.get(d.saleId);
    if (!venta) {
      plan.sinCliente.push({ returnId: d.id, amount, motivo: 'la venta ya no existe' });
      continue;
    }
    const porDoc = venta.docNumber ? clientesPorDocumento.get(soloDigitos(venta.docNumber)) : undefined;
    const customerId = venta.customerId ?? porDoc?.id;
    if (!customerId) {
      plan.sinCliente.push({
        returnId: d.id,
        saleNumber: venta.saleNumber,
        amount,
        motivo: venta.docNumber ? 'el documento de la venta no es de ningún cliente registrado' : 'la venta no tiene documento del cliente',
      });
      continue;
    }
    plan.abonos.push({
      returnId: d.id,
      customerId,
      customerName: venta.customerName ?? porDoc?.name,
      amount,
      memo: `Saldo a favor histórico de la venta ${venta.saleNumber}`,
    });
  }
  return plan;
}

/** Llave del documento para buscar clientes (la misma normalización del plan). */
export const llaveDocumento = soloDigitos;
