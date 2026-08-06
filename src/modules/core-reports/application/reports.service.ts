import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../../sales/infrastructure/schemas/sale.schema';
import { LedgerService, TrialBalanceRow } from '../../core-ledger/application/ledger.service';

/** Una línea (cuenta) de un estado financiero. */
interface StatementLine {
  code: string;
  name: string;
  amount: number;
}

/**
 * Motor de reportes. Los estados financieros LEEN DEL LEDGER (nunca de las
 * tablas operativas), tal como exige el estándar transversal. El reporte de
 * ventas sí consulta la operación para dar una vista rápida del día a día.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly ledger: LedgerService,
    @InjectModel(Sale.name) private readonly sales: Model<SaleDocument>,
  ) {}

  /** Catálogo de reportes disponibles (para la UI). */
  catalog() {
    return [
      {
        key: 'income-statement',
        name: 'Estado de resultados',
        description: 'Ingresos − gastos del periodo (desde el ledger).',
        source: 'ledger',
      },
      {
        key: 'balance-sheet',
        name: 'Balance general',
        description: 'Activo = Pasivo + Patrimonio a una fecha.',
        source: 'ledger',
      },
      {
        key: 'trial-balance',
        name: 'Balance de comprobación',
        description: 'Débitos y créditos por cuenta.',
        source: 'ledger',
      },
      {
        key: 'sales',
        name: 'Ventas por día',
        description: 'Ingresos, tiquetes y ticket promedio.',
        source: 'operación',
      },
    ];
  }

  /** Estado de resultados: ingresos − gastos según el ledger del rango. */
  async incomeStatement(query: { from?: string; to?: string; sedeId?: string }) {
    const tb = await this.ledger.trialBalance(query);
    const income = this.linesOf(tb.rows, 'income');
    const expense = this.linesOf(tb.rows, 'expense');
    const totalIngresos = this.sum(income);
    const totalGastos = this.sum(expense);
    return {
      from: query.from,
      to: query.to,
      sedeId: query.sedeId ?? null,
      ingresos: income,
      totalIngresos,
      gastos: expense,
      totalGastos,
      utilidadNeta: totalIngresos - totalGastos,
    };
  }

  /** Balance general a una fecha (todo el ledger hasta `to`). */
  async balanceSheet(query: { to?: string; sedeId?: string }) {
    const tb = await this.ledger.trialBalance({ to: query.to, sedeId: query.sedeId });
    const activos = this.linesOf(tb.rows, 'asset');
    const pasivos = this.linesOf(tb.rows, 'liability');
    const patrimonio = this.linesOf(tb.rows, 'equity');
    const income = this.sum(this.linesOf(tb.rows, 'income'));
    const expense = this.sum(this.linesOf(tb.rows, 'expense'));
    const resultadoEjercicio = income - expense;

    const totalActivo = this.sum(activos);
    const totalPasivo = this.sum(pasivos);
    // El resultado del ejercicio aún no cerrado suma al patrimonio.
    const totalPatrimonio = this.sum(patrimonio) + resultadoEjercicio;
    return {
      to: query.to ?? null,
      sedeId: query.sedeId ?? null,
      activos,
      totalActivo,
      pasivos,
      totalPasivo,
      patrimonio,
      resultadoEjercicio,
      totalPatrimonio,
      cuadra: totalActivo === totalPasivo + totalPatrimonio,
    };
  }

  async trialBalance(query: { from?: string; to?: string; sedeId?: string }) {
    return this.ledger.trialBalance(query);
  }

  /** Ventas por día (operación): ingresos, tiquetes y ticket promedio. */
  async salesReport(query: { from?: string; to?: string; sedeId?: string }) {
    const match: Record<string, unknown> = { status: 'completed' };
    if (query.sedeId) match.sedeId = new Types.ObjectId(query.sedeId);
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(`${query.from}T00:00:00`);
      if (query.to) range.$lte = new Date(`${query.to}T23:59:59.999`);
      match.createdAt = range;
    }
    // Un solo agregado con $facet: por día, por medio de pago, por sede y top
    // productos. Enriquece el reporte de ventas sin varias consultas.
    const [facet] = (await this.sales
      .aggregate([
        { $match: match },
        {
          $facet: {
            days: [
              {
                $group: {
                  _id: {
                    $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
                  },
                  revenue: { $sum: '$total' },
                  tax: { $sum: '$taxTotal' },
                  tickets: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
            byMethod: [
              {
                $group: {
                  _id: '$payment.method',
                  revenue: { $sum: '$total' },
                  tickets: { $sum: 1 },
                },
              },
              { $sort: { revenue: -1 } },
            ],
            bySede: [
              {
                $group: {
                  _id: '$sedeId',
                  revenue: { $sum: '$total' },
                  tickets: { $sum: 1 },
                },
              },
              { $sort: { revenue: -1 } },
            ],
            topProducts: [
              { $unwind: '$lines' },
              {
                $group: {
                  _id: '$lines.productId',
                  name: { $first: '$lines.name' },
                  qty: { $sum: '$lines.qty' },
                  revenue: { $sum: '$lines.lineTotal' },
                },
              },
              { $sort: { revenue: -1 } },
              { $limit: 10 },
            ],
            totals: [
              {
                $group: {
                  _id: null,
                  revenue: { $sum: '$total' },
                  tax: { $sum: '$taxTotal' },
                  tickets: { $sum: 1 },
                },
              },
            ],
          },
        },
      ])
      .exec()) as {
      days: { _id: string; revenue: number; tax: number; tickets: number }[];
      byMethod: { _id: string; revenue: number; tickets: number }[];
      bySede: { _id: Types.ObjectId; revenue: number; tickets: number }[];
      topProducts: {
        _id: Types.ObjectId;
        name: string;
        qty: number;
        revenue: number;
      }[];
      totals: { revenue: number; tax: number; tickets: number }[];
    }[];

    const days = (facet?.days ?? []).map((r) => ({
      date: r._id,
      revenue: r.revenue,
      tax: r.tax,
      tickets: r.tickets,
      avgTicket: r.tickets ? Math.round(r.revenue / r.tickets) : 0,
    }));
    const byMethod = (facet?.byMethod ?? []).map((r) => ({
      method: r._id ?? 'desconocido',
      revenue: r.revenue,
      tickets: r.tickets,
    }));
    const bySede = (facet?.bySede ?? []).map((r) => ({
      sedeId: r._id ? r._id.toString() : null,
      revenue: r.revenue,
      tickets: r.tickets,
    }));
    const topProducts = (facet?.topProducts ?? []).map((r) => ({
      productId: r._id ? r._id.toString() : null,
      name: r.name,
      qty: r.qty,
      revenue: r.revenue,
    }));
    const t = facet?.totals?.[0] ?? { revenue: 0, tax: 0, tickets: 0 };
    return {
      from: query.from,
      to: query.to,
      sedeId: query.sedeId ?? null,
      days,
      byMethod,
      bySede,
      topProducts,
      totalRevenue: t.revenue,
      totalTax: t.tax,
      totalTickets: t.tickets,
      avgTicket: t.tickets ? Math.round(t.revenue / t.tickets) : 0,
    };
  }

  private linesOf(rows: TrialBalanceRow[], type: string): StatementLine[] {
    return rows
      .filter((r) => r.type === type)
      .map((r) => ({ code: r.code, name: r.name, amount: Math.abs(r.balance) }))
      .filter((l) => l.amount !== 0);
  }

  private sum(lines: StatementLine[]): number {
    return lines.reduce((a, l) => a + l.amount, 0);
  }
}
