import { Money } from "@shared/money/Money.js";

/**
 * Ledger de partida doble — esqueleto del dominio.
 *
 * Invariantes (a hacer cumplir en la implementación):
 *  - Un asiento (JournalEntry) es INMUTABLE una vez registrado.
 *  - La suma de débitos == suma de créditos (balanceado).
 *  - Corregir NO es editar: se emite un contra-asiento que reversa.
 *  - Todo evento de negocio (venta, gasto, pago, ajuste, propina) genera un asiento.
 *  - Se persiste dentro de la misma transacción Mongo que la operación que lo origina.
 */

export type EntrySide = "debit" | "credit";

export interface LedgerLine {
  readonly account: string; // cuenta contable interna
  readonly side: EntrySide;
  readonly amount: Money;
  readonly sede: string;
}

export interface JournalEntry {
  readonly id: string;
  readonly occurredAt: Date;
  readonly sourceType: string; // "sale" | "expense" | "payment" | "adjustment" | ...
  readonly sourceId: string; // id del evento de negocio que lo originó
  readonly lines: readonly LedgerLine[];
  readonly reversalOf?: string; // id del asiento que este contra-asiento reversa
}

/** Verifica que el asiento esté balanceado (débitos == créditos). */
export function isBalanced(lines: readonly LedgerLine[]): boolean {
  let debit = Money.fromCents(0n);
  let credit = Money.fromCents(0n);
  for (const line of lines) {
    if (line.side === "debit") debit = debit.add(line.amount);
    else credit = credit.add(line.amount);
  }
  return debit.subtract(credit).isZero();
}
