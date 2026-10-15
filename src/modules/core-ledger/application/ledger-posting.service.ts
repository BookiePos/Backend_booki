import { Injectable, Logger } from '@nestjs/common';
import { LedgerService, PostLine } from './ledger.service';
import { LedgerConciliacionService } from './ledger-conciliacion.service';
import { ACC } from '../domain/ledger.constants';
import { cop, sumBy } from '../../finance/domain/money.util';

/**
 * Posteo automático al ledger desde los eventos de negocio (venta, gasto,
 * pago, compra, nómina). Traduce cada evento a un asiento balanceado.
 *
 * Decisión pragmática: como Mongo corre standalone (sin transacciones
 * multi-documento) y el ledger es una PROYECCIÓN derivada de la operación, un
 * fallo al postear NO tumba la operación de negocio (la venta/gasto es la
 * fuente de verdad; el asiento puede reconstruirse): queda como pendiente de
 * conciliación de la empresa (`LedgerConciliacionService`) y lo resuelve
 * `src/datos/2026-10-reconstruir-asientos.ts`. El posteo es idempotente por
 * (sourceType, sourceId) —lo garantiza el índice único del libro— para
 * permitir reintentos.
 */
@Injectable()
export class LedgerPostingService {
  private readonly logger = new Logger('LedgerPosting');

  constructor(
    private readonly ledger: LedgerService,
    private readonly conciliacion: LedgerConciliacionService,
  ) {}

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
      if (existing) return; // ya posteado (atajo; el índice cubre la carrera)
      await this.ledger.post({
        date: input.date,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        memo: input.memo,
        lines: input.lines,
        createdByEmail: input.userEmail,
      });
    } catch (err) {
      const error = (err as Error).message;
      this.logger.error(
        `CONCILIAR: no se pudo postear el asiento ${input.sourceType} ${input.sourceId}: ${error}`,
      );
      await this.conciliacion.registrar({
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        operacion: 'post',
        error,
      });
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
      // Sigue siendo best-effort (las anulaciones de venta, gasto, CxP, etc.
      // no se tumban por el libro), pero queda un asiento vivo de algo
      // anulado: ERROR con los ids para conciliarlo a mano.
      const error = (err as Error).message;
      this.logger.error(
        `CONCILIAR: no se pudo reversar el asiento ${sourceType} ${sourceId}: ${error}`,
      );
      await this.conciliacion.registrar({
        sourceType,
        sourceId,
        operacion: 'reverse',
        error,
      });
    }
  }

  // ── Ventas ──────────────────────────────────────────────────────────────────

  /**
   * Venta completada. Débito a Caja/Bancos (o Clientes si es fiado) por el
   * total; crédito a Ingresos por el neto, a IVA por pagar (2408) por el IVA y
   * a INC por pagar (2495) por el impuesto al consumo.
   * Si hay costo (COGS): débito Costo de venta, crédito Inventario.
   */
  async postSale(input: {
    saleId: string;
    number: string;
    date: string;
    sedeId: string;
    total: number;
    /** IVA incluido en el total (cuenta 2408). */
    tax: number;
    /** INC incluido en el total (cuenta 2495). Restaurantes y bares. */
    consumptionTax?: number;
    cogs: number;
    /**
     * Cobro del domicilio. Es ingreso del negocio pero NO lleva IVA, así que
     * entra entero a Ingresos sin nada que separar.
     */
    deliveryFee?: number;
    /**
     * Propina (ítem 1.10). Entra a Caja o Bancos con el resto del cobro, pero
     * es del personal (Ley 1935/2018): va al pasivo 2380, nunca a Ingresos.
     * La propina no se fía, así que en una venta a crédito no entra.
     */
    tip?: number;
    paymentMethod?: string;
    onCredit?: boolean;
    userEmail?: string;
  }): Promise<void> {
    const total = cop(input.total);
    const tax = cop(input.tax);
    const inc = cop(input.consumptionTax ?? 0);
    const delivery = cop(input.deliveryFee ?? 0);
    const income = total - tax - inc + delivery;
    const cogs = cop(input.cogs);
    const tip = input.onCredit ? 0 : cop(input.tip ?? 0);
    const debitAccount = input.onCredit
      ? ACC.CLIENTES
      : this.funding(input.paymentMethod);

    const lines: PostLine[] = [
      {
        accountCode: debitAccount,
        debit: total + delivery + tip,
        sedeId: input.sedeId,
      },
      { accountCode: ACC.INGRESOS_VENTAS, credit: income, sedeId: input.sedeId },
    ];
    if (tip > 0) {
      lines.push({ accountCode: ACC.PROPINAS_POR_PAGAR, credit: tip, sedeId: input.sedeId });
    }
    if (tax > 0) {
      lines.push({ accountCode: ACC.IVA_POR_PAGAR, credit: tax, sedeId: input.sedeId });
    }
    if (inc > 0) {
      lines.push({ accountCode: ACC.INC_POR_PAGAR, credit: inc, sedeId: input.sedeId });
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

  /**
   * Devolución PARCIAL de una venta: el espejo de la venta, pero solo por lo
   * que volvió.
   *
   * No se reversa el asiento de la venta porque esa venta sí ocurrió: el
   * cliente se quedó con el resto. Se postea un asiento propio que baja el
   * ingreso y el IVA por el monto devuelto, contra la cuenta por la que sale
   * la plata.
   *
   * `credit_note` y `none` no sacan plata hoy —una queda a favor del cliente y
   * la otra es un cambio por otro producto—, así que la contrapartida es
   * Clientes: lo que el negocio le queda debiendo.
   *
   * El costo solo se deshace si la mercancía VOLVIÓ al inventario. Si se fue a
   * merma, el inventario se perdió igual y el costo de venta se queda.
   */
  async postSaleReturn(input: {
    returnId: string;
    saleNumber: string;
    date: string;
    sedeId: string;
    refundTotal: number;
    /** IVA incluido en lo devuelto (cuenta 2408). */
    tax: number;
    /** INC incluido en lo devuelto (cuenta 2495). */
    consumptionTax?: number;
    cogs: number;
    refundMethod: string;
    userEmail?: string;
  }): Promise<void> {
    const total = cop(input.refundTotal);
    if (total <= 0 && input.cogs <= 0) return;
    const tax = cop(input.tax);
    const inc = cop(input.consumptionTax ?? 0);
    const income = total - tax - inc;
    const cogs = cop(input.cogs);

    const contrapartida =
      input.refundMethod === 'credit_note' || input.refundMethod === 'none'
        ? ACC.CLIENTES
        : this.funding(input.refundMethod);

    const lines: PostLine[] = [];
    if (total > 0) {
      lines.push({ accountCode: contrapartida, credit: total, sedeId: input.sedeId });
      if (income > 0) {
        // 4175 y no 4135: la devolución resta del ingreso pero se ve aparte.
        lines.push({
          accountCode: ACC.DEVOLUCIONES_VENTAS,
          debit: income,
          sedeId: input.sedeId,
        });
      }
      if (tax > 0) {
        lines.push({
          accountCode: ACC.IVA_POR_PAGAR,
          debit: tax,
          sedeId: input.sedeId,
        });
      }
      if (inc > 0) {
        lines.push({
          accountCode: ACC.INC_POR_PAGAR,
          debit: inc,
          sedeId: input.sedeId,
        });
      }
    }
    if (cogs > 0) {
      lines.push({ accountCode: ACC.INVENTARIO, debit: cogs, sedeId: input.sedeId });
      lines.push({ accountCode: ACC.COSTO_VENTA, credit: cogs, sedeId: input.sedeId });
    }

    await this.safePost({
      date: input.date,
      sourceType: 'sale_return',
      sourceId: input.returnId,
      memo: `Devolución de la venta ${input.saleNumber}`,
      lines,
      userEmail: input.userEmail,
    });
  }

  // ── Gastos ──────────────────────────────────────────────────────────────────

  /**
   * Gasto. Débito a la cuenta de gasto por la base y, si la sede descuenta el
   * IVA, a la 2408 por el IVA descontable (igual que la recepción de compra);
   * si no lo descuenta (no responsable o restaurante con INC, arts. 437 y 488
   * ET) el IVA va al gasto. Crédito a Caja/Bancos si está pagado, o a
   * Proveedores (CxP) si queda por pagar.
   */
  async postExpense(input: {
    expenseId: string;
    date: string;
    sedeId: string;
    amount: number;
    tax: number;
    /** Parte de `tax` que es IVA descontable (débito 2408). Sin él, todo va al gasto. */
    ivaDescontable?: number;
    status: 'paid' | 'payable';
    paymentMethod?: string;
    expenseAccount?: string;
    concept: string;
    /** Retenciones practicadas al proveedor (ReteFuente, ReteIVA, ReteICA). */
    withholding?: number;
    userEmail?: string;
  }): Promise<void> {
    const gross = cop(input.amount) + cop(input.tax);
    // Lo retenido no sale hacia el proveedor: se le debe a la DIAN. El gasto
    // sigue siendo el bruto; cambia a quién se le debe cada parte.
    const withholding = Math.min(
      Math.max(cop(input.withholding ?? 0), 0),
      gross,
    );
    const credit =
      input.status === 'paid'
        ? this.funding(input.paymentMethod)
        : ACC.PROVEEDORES;
    const iva = Math.min(Math.max(cop(input.ivaDescontable ?? 0), 0), cop(input.tax));
    const lines: PostLine[] = [];
    if (gross - iva > 0) {
      lines.push({
        accountCode: input.expenseAccount ?? ACC.GASTOS_DIVERSOS,
        debit: gross - iva,
        sedeId: input.sedeId,
      });
    }
    lines.push({ accountCode: credit, credit: gross - withholding, sedeId: input.sedeId });
    if (iva > 0) {
      lines.push({ accountCode: ACC.IVA_POR_PAGAR, debit: iva, sedeId: input.sedeId });
    }
    if (withholding > 0) {
      lines.push({
        accountCode: ACC.RETENCION_FUENTE,
        credit: withholding,
        sedeId: input.sedeId,
      });
    }
    await this.safePost({
      date: input.date,
      sourceType: 'expense',
      sourceId: input.expenseId,
      memo: `Gasto: ${input.concept}`,
      lines,
      userEmail: input.userEmail,
    });
  }

  /**
   * Reversa el asiento vivo de un gasto. Al editarlo se reversa y se vuelve a
   * postear con los datos nuevos (el asiento no se edita); al borrarlo solo se
   * reversa.
   */
  async reverseExpense(expenseId: string, userEmail?: string): Promise<void> {
    await this.safeReverse('expense', expenseId, userEmail);
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
    const amount = cop(input.amount);
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
    const amount = cop(input.amount);
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

  /**
   * Recepción de compra. Débito a Inventario por lo que entra al costo y, si el
   * negocio lo descuenta, a IVA (2408) por el IVA descontable; crédito por el
   * TOTAL de la factura a Proveedores (CxP) o, de contado, al medio con que se
   * pagó (efectivo → Caja; transferencia/tarjeta → Bancos).
   *
   * El IVA descontable se debita en la misma 2408 del IVA generado: el plan no
   * maneja auxiliares y esa es la dinámica de la cuenta en el PUC (Decreto
   * 2650/93: la 2408 se debita por los impuestos descontables). Quien no lo
   * descuenta (no responsable o restaurante con INC, arts. 437 y 488 ET) llega
   * aquí con `ivaDescontable` en 0 y el IVA ya sumado a `amount`.
   */
  async postPurchaseReceipt(input: {
    receiptId: string;
    date: string;
    sedeId: string;
    /** Lo que entra al inventario: la base, más el IVA cuando no es descontable. */
    amount: number;
    /** IVA descontable de la factura (débito 2408). */
    ivaDescontable?: number;
    onCredit: boolean;
    /** Medio de pago de contado. Sin él se asume efectivo (lo de antes). */
    paymentMethod?: string;
    number: string;
    userEmail?: string;
  }): Promise<void> {
    const amount = cop(input.amount);
    const iva = cop(input.ivaDescontable ?? 0);
    const total = amount + iva;
    if (total <= 0) return;
    const credit = input.onCredit
      ? ACC.PROVEEDORES
      : this.funding(input.paymentMethod ?? 'cash');
    const lines: PostLine[] = [];
    if (amount > 0) {
      lines.push({ accountCode: ACC.INVENTARIO, debit: amount, sedeId: input.sedeId });
    }
    if (iva > 0) {
      lines.push({ accountCode: ACC.IVA_POR_PAGAR, debit: iva, sedeId: input.sedeId });
    }
    lines.push({ accountCode: credit, credit: total, sedeId: input.sedeId });
    await this.safePost({
      date: input.date,
      sourceType: 'purchase_receipt',
      sourceId: input.receiptId,
      memo: `Recepción ${input.number}`,
      lines,
      userEmail: input.userEmail,
    });
  }

  // ── Nómina ────────────────────────────────────────────────────────────────────

  /**
   * Nómina causada (ítem 1.9). Débito a gastos de personal por el costo del
   * empleador y el pasivo separado por concepto, para que cada cuenta se pueda
   * pagar y conciliar sola (PILA, retención, fondos, empleados):
   *   2505 neto a pagar · 2370 salud, pensión y FSP del empleado + aportes del
   *   empleador · 2610 provisiones · 2365 retención en la fuente · 1305 el
   *   consumo fiado que se descontó, que cancela la CxC del empleado.
   * El débito es la suma de los créditos, así que el asiento cuadra exacto.
   */
  async postPayrollRun(input: {
    runId: string;
    date: string;
    sedeId?: string;
    period: string;
    partes: {
      neto: number;
      seguridadSocialEmpleado: number;
      retencionFuente: number;
      fiado: number;
      aportesEmpleador: number;
      provisiones: number;
    };
    userEmail?: string;
  }): Promise<void> {
    const p = input.partes;
    const creditos: [string, number][] = [
      [ACC.SALARIOS_POR_PAGAR, cop(p.neto)],
      [ACC.APORTES_NOMINA, cop(p.seguridadSocialEmpleado) + cop(p.aportesEmpleador)],
      [ACC.PROVISIONES_LABORALES, cop(p.provisiones)],
      [ACC.RETENCION_FUENTE, cop(p.retencionFuente)],
      [ACC.CLIENTES, cop(p.fiado)],
    ];
    const costo = sumBy(creditos, ([, monto]) => monto);
    if (costo <= 0) return;
    await this.safePost({
      date: input.date,
      sourceType: 'payroll_run',
      sourceId: input.runId,
      memo: `Nómina ${input.period}`,
      lines: [
        { accountCode: ACC.GASTOS_PERSONAL, debit: costo, sedeId: input.sedeId },
        ...creditos
          .filter(([, monto]) => monto > 0)
          .map(([accountCode, monto]) => ({
            accountCode,
            credit: monto,
            sedeId: input.sedeId,
          })),
      ],
      userEmail: input.userEmail,
    });
  }

  // ── Producción ────────────────────────────────────────────────────────────────

  /**
   * Cierre de una orden de producción (ítem 1.20). Los insumos pasan de
   * materia prima a terminado dentro de la misma 1435, así que solo se asienta
   * lo que el terminado vale de más: la mano de obra y el empaque del lote, que
   * ya están en gastos y se trasladan al inventario acreditando costos
   * absorbidos. Sin esto, al vender el terminado la 6135 sumaba otra vez la
   * mano de obra que la nómina ya llevó al gasto, y la 1435 quedaba por debajo
   * del kardex.
   *
   *   Débito 1435  valorTerminado − materiales
   *   Crédito 7205 mano de obra
   *   Crédito 7305 el resto (empaque y residuo del redondeo del lote)
   */
  async postProductionOrder(input: {
    orderId: string;
    number: string;
    date: string;
    sedeId: string;
    valorTerminado: number;
    materiales: number;
    manoDeObra: number;
    userEmail?: string;
  }): Promise<void> {
    const agregado = cop(input.valorTerminado) - cop(input.materiales);
    const manoDeObra = cop(input.manoDeObra);
    const indirectos = agregado - manoDeObra;
    const lines: PostLine[] = [];
    const lado = (accountCode: string, monto: number, natural: 'debit' | 'credit') => {
      if (monto === 0) return;
      const side = monto > 0 ? natural : natural === 'debit' ? 'credit' : 'debit';
      lines.push({ accountCode, [side]: Math.abs(monto), sedeId: input.sedeId });
    };
    lado(ACC.INVENTARIO, agregado, 'debit');
    lado(ACC.MANO_OBRA_ABSORBIDA, manoDeObra, 'credit');
    lado(ACC.COSTOS_INDIRECTOS_ABSORBIDOS, indirectos, 'credit');
    if (lines.length === 0) return;
    await this.safePost({
      date: input.date,
      sourceType: 'production_order',
      sourceId: input.orderId,
      memo: `Producción ${input.number}`,
      lines,
      userEmail: input.userEmail,
    });
  }
}
