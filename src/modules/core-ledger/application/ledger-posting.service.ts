import { Injectable, Logger } from '@nestjs/common';
import { LedgerService, PostLine } from './ledger.service';
import { ACC } from '../domain/ledger.constants';

/**
 * Posteo automático al ledger desde los eventos de negocio (venta, gasto,
 * pago, compra, nómina). Traduce cada evento a un asiento balanceado.
 *
 * Decisión pragmática: como Mongo corre standalone (sin transacciones
 * multi-documento) y el ledger es una PROYECCIÓN derivada de la operación, un
 * fallo al postear se registra como warning y NO tumba la operación de negocio
 * (la venta/gasto es la fuente de verdad; el asiento puede reconstruirse). El
 * posteo es idempotente por (sourceType, sourceId) para permitir reintentos.
 */
@Injectable()
export class LedgerPostingService {
  private readonly logger = new Logger('LedgerPosting');

  constructor(private readonly ledger: LedgerService) {}

  private funding(method?: string): string {
    // Efectivo → Caja; débito/crédito/transferencia/Nequi/Daviplata → Bancos.
    return method === 'cash' ? ACC.CAJA : ACC.BANCOS;
  }

  /** Postea de forma segura e idempotente. */
  private async safePost(input: {
    date: string;
    sourceType: string;
    sourceId: string;
    memo: string;
    lines: PostLine[];
    userEmail?: string;
  }): Promise<void> {
    try {
      const existing = await this.ledger.findBySource(
        input.sourceType,
        input.sourceId,
      );
      if (existing) return; // ya posteado
      await this.ledger.post({
        date: input.date,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        memo: input.memo,
        lines: input.lines,
        createdByEmail: input.userEmail,
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo postear ${input.sourceType} ${input.sourceId}: ${(err as Error).message}`,
      );
    }
  }

  private async safeReverse(
    sourceType: string,
    sourceId: string,
    userEmail?: string,
  ): Promise<void> {
    try {
      await this.ledger.reverseBySource(sourceType, sourceId, userEmail);
    } catch (err) {
      this.logger.warn(
        `No se pudo reversar ${sourceType} ${sourceId}: ${(err as Error).message}`,
      );
    }
  }

  // ── Ventas ──────────────────────────────────────────────────────────────────

  /**
   * Venta completada. Débito a Caja/Bancos (o Clientes si es fiado) por el
   * total; crédito a Ingresos por el neto y a IVA por pagar por el impuesto.
   * Si hay costo (COGS): débito Costo de venta, crédito Inventario.
   */
  async postSale(input: {
    saleId: string;
    number: string;
    date: string;
    sedeId: string;
    total: number;
    tax: number;
    cogs: number;
    paymentMethod?: string;
    onCredit?: boolean;
    userEmail?: string;
  }): Promise<void> {
    const total = Math.round(input.total);
    const tax = Math.round(input.tax);
    const income = total - tax;
    const cogs = Math.round(input.cogs);
    const debitAccount = input.onCredit
      ? ACC.CLIENTES
      : this.funding(input.paymentMethod);

    const lines: PostLine[] = [
      { accountCode: debitAccount, debit: total, sedeId: input.sedeId },
      { accountCode: ACC.INGRESOS_VENTAS, credit: income, sedeId: input.sedeId },
    ];
    if (tax > 0) {
      lines.push({ accountCode: ACC.IVA_POR_PAGAR, credit: tax, sedeId: input.sedeId });
    }
    if (cogs > 0) {
      lines.push({ accountCode: ACC.COSTO_VENTA, debit: cogs, sedeId: input.sedeId });
      lines.push({ accountCode: ACC.INVENTARIO, credit: cogs, sedeId: input.sedeId });
    }

    await this.safePost({
      date: input.date,
      sourceType: 'sale',
      sourceId: input.saleId,
      memo: `Venta ${input.number}`,
      lines,
      userEmail: input.userEmail,
    });
  }

  async reverseSale(saleId: string, userEmail?: string): Promise<void> {
    await this.safeReverse('sale', saleId, userEmail);
  }

  // ── Gastos ──────────────────────────────────────────────────────────────────

  /**
   * Gasto. Débito a la cuenta de gasto por (base + impuesto); crédito a
   * Caja/Bancos si está pagado, o a Proveedores (CxP) si queda por pagar.
   */
  async postExpense(input: {
    expenseId: string;
    date: string;
    sedeId: string;
    amount: number;
    tax: number;
    status: 'paid' | 'payable';
    paymentMethod?: string;
    expenseAccount?: string;
    concept: string;
    userEmail?: string;
  }): Promise<void> {
    const gross = Math.round(input.amount) + Math.round(input.tax);
    const credit =
      input.status === 'paid'
        ? this.funding(input.paymentMethod)
        : ACC.PROVEEDORES;
    await this.safePost({
      date: input.date,
      sourceType: 'expense',
      sourceId: input.expenseId,
      memo: `Gasto: ${input.concept}`,
      lines: [
        {
          accountCode: input.expenseAccount ?? ACC.GASTOS_DIVERSOS,
          debit: gross,
          sedeId: input.sedeId,
        },
        { accountCode: credit, credit: gross, sedeId: input.sedeId },
      ],
      userEmail: input.userEmail,
    });
  }

  // ── Pagos de CxP / CxC ────────────────────────────────────────────────────────

  /** Abono a proveedor: débito Proveedores, crédito Caja/Bancos. */
  async postPayablePayment(input: {
    paymentId: string;
    date: string;
    sedeId: string;
    amount: number;
    paymentMethod?: string;
    docNumber?: string;
    userEmail?: string;
  }): Promise<void> {
    const amount = Math.round(input.amount);
    await this.safePost({
      date: input.date,
      sourceType: 'payable_payment',
      sourceId: input.paymentId,
      memo: `Pago CxP ${input.docNumber ?? ''}`.trim(),
      lines: [
        { accountCode: ACC.PROVEEDORES, debit: amount, sedeId: input.sedeId },
        { accountCode: this.funding(input.paymentMethod), credit: amount, sedeId: input.sedeId },
      ],
      userEmail: input.userEmail,
    });
  }

  /** Abono de cliente: débito Caja/Bancos, crédito Clientes. */
  async postReceivablePayment(input: {
    paymentId: string;
    date: string;
    sedeId: string;
    amount: number;
    paymentMethod?: string;
    docNumber?: string;
    userEmail?: string;
  }): Promise<void> {
    const amount = Math.round(input.amount);
    await this.safePost({
      date: input.date,
      sourceType: 'receivable_payment',
      sourceId: input.paymentId,
      memo: `Cobro CxC ${input.docNumber ?? ''}`.trim(),
      lines: [
        { accountCode: this.funding(input.paymentMethod), debit: amount, sedeId: input.sedeId },
        { accountCode: ACC.CLIENTES, credit: amount, sedeId: input.sedeId },
      ],
      userEmail: input.userEmail,
    });
  }

  // ── Compras ───────────────────────────────────────────────────────────────────

  /** Recepción de compra: débito Inventario, crédito Proveedores o Caja. */
  async postPurchaseReceipt(input: {
    receiptId: string;
    date: string;
    sedeId: string;
    amount: number;
    onCredit: boolean;
    number: string;
    userEmail?: string;
  }): Promise<void> {
    const amount = Math.round(input.amount);
    if (amount <= 0) return;
    await this.safePost({
      date: input.date,
      sourceType: 'purchase_receipt',
      sourceId: input.receiptId,
      memo: `Recepción ${input.number}`,
      lines: [
        { accountCode: ACC.INVENTARIO, debit: amount, sedeId: input.sedeId },
        {
          accountCode: input.onCredit ? ACC.PROVEEDORES : ACC.CAJA,
          credit: amount,
          sedeId: input.sedeId,
        },
      ],
      userEmail: input.userEmail,
    });
  }

  // ── Nómina ────────────────────────────────────────────────────────────────────

  /** Nómina causada: débito Gastos de personal, crédito Salarios por pagar. */
  async postPayrollRun(input: {
    runId: string;
    date: string;
    sedeId?: string;
    amount: number;
    period: string;
    userEmail?: string;
  }): Promise<void> {
    const amount = Math.round(input.amount);
    if (amount <= 0) return;
    await this.safePost({
      date: input.date,
      sourceType: 'payroll_run',
      sourceId: input.runId,
      memo: `Nómina ${input.period}`,
      lines: [
        { accountCode: ACC.GASTOS_PERSONAL, debit: amount, sedeId: input.sedeId },
        { accountCode: ACC.SALARIOS_POR_PAGAR, credit: amount, sedeId: input.sedeId },
      ],
      userEmail: input.userEmail,
    });
  }
}
