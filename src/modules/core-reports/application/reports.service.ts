import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../../sales/infrastructure/schemas/sale.schema';
import {
  SaleReturn,
  SaleReturnDocument,
} from '../../sales/infrastructure/schemas/sale-return.schema';
import { BY_METHOD_PIPELINE } from './by-method.pipeline';
import { LedgerService, TrialBalanceRow } from '../../core-ledger/application/ledger.service';
import { balancePorSedes } from '../../core-ledger/domain/ledger-sede-scope';
import {
  SedeScopeUser,
  alcanceDeSedes,
  resolveSedeScope,
} from '../../core-auth/domain/sede-access';
import {
  RETURNS_FACET,
  RetornosFacet,
  netearVentas,
} from './sales-returns.report';

/** Colombia no tiene horario de verano: el desfase es fijo. */
const TZ = 'America/Bogota';
const OFFSET = '-05:00';

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
 *
 * Todos respetan el alcance por sede del usuario (checklist 3.3): una sede
 * ajena es 403 y, sin sede, el informe se arma solo con las suyas. El Dueño y
 * `sede.view_all` ven la empresa entera.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly ledger: LedgerService,
    @InjectModel(Sale.name) private readonly sales: Model<SaleDocument>,
    @InjectModel(SaleReturn.name)
    private readonly saleReturns: Model<SaleReturnDocument>,
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
        description:
          'Ventas netas de devoluciones, tiquetes, ticket promedio y la cuenta de las devoluciones.',
        source: 'operación',
      },
    ];
  }

  /** Estado de resultados: ingresos − gastos según el ledger del rango. */
  async incomeStatement(
    query: { from?: string; to?: string; sedeId?: string },
    user: SedeScopeUser,
  ) {
    const sedes = resolveSedeScope(user, query.sedeId);
    const tb = await this.balance({ from: query.from, to: query.to }, sedes);
    const income = this.linesOf(tb.rows, 'income');
    const expense = this.linesOf(tb.rows, 'expense');
    const totalIngresos = this.sum(income);
    const totalGastos = this.sum(expense);
    return {
      from: query.from,
      to: query.to,
      sedeId: query.sedeId ?? null,
      ...alcanceDeSedes(sedes),
      ingresos: income,
      totalIngresos,
      gastos: expense,
      totalGastos,
      utilidadNeta: totalIngresos - totalGastos,
    };
  }

  /** Balance general a una fecha (todo el ledger hasta `to`). */
  async balanceSheet(
    query: { to?: string; sedeId?: string },
    user: SedeScopeUser,
  ) {
    const sedes = resolveSedeScope(user, query.sedeId);
    const tb = await this.balance({ to: query.to }, sedes);
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
      ...alcanceDeSedes(sedes),
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

  async trialBalance(
    query: { from?: string; to?: string; sedeId?: string },
    user: SedeScopeUser,
  ) {
    const sedes = resolveSedeScope(user, query.sedeId);
    const tb = await this.balance({ from: query.from, to: query.to }, sedes);
    return { ...tb, ...alcanceDeSedes(sedes) };
  }

  /** Balance de comprobación del ledger, limitado a las sedes del alcance. */
  private balance(
    query: { from?: string; to?: string },
    sedeIds: string[] | null,
  ) {
    return balancePorSedes((q) => this.ledger.trialBalance(q), query, sedeIds);
  }

  /** Ventas por día (operación): ingresos, tiquetes y ticket promedio. */
  async salesReport(
    query: { from?: string; to?: string; sedeId?: string },
    user: SedeScopeUser,
  ) {
    const match: Record<string, unknown> = { status: 'completed' };
    const sedes = resolveSedeScope(user, query.sedeId);
    if (sedes) {
      match.sedeId = { $in: sedes.map((s) => new Types.ObjectId(s)) };
    }
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      // Día de Colombia, no del servidor (Vercel corre en UTC: lo vendido
      // después de las 7 p. m. caía en el día siguiente).
      if (query.from) range.$gte = new Date(`${query.from}T00:00:00${OFFSET}`);
      if (query.to) range.$lte = new Date(`${query.to}T23:59:59.999${OFFSET}`);
      match.createdAt = range;
    }
    // Un solo agregado con $facet: por día, por medio de pago, por sede y top
    // productos. Enriquece el reporte de ventas sin varias consultas.
    // Devoluciones con la MISMA regla de sede y fechas, sin filtro de status:
    // restan el día en que ocurren (R3, revisión 1.16).
    const returnsMatch: Record<string, unknown> = { ...match };
    delete returnsMatch.status;
    const [[facet], [retornos]] = (await Promise.all([
      this.sales
        .aggregate([
          { $match: match },
          {
            $facet: {
              days: [
                {
                  $group: {
                    _id: {
                      $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$createdAt',
                        timezone: TZ,
                      },
                    },
                    revenue: { $sum: '$total' },
                    tax: { $sum: '$taxTotal' },
                    tickets: { $sum: 1 },
                  },
                },
                { $sort: { _id: 1 } },
              ],
              // Cobro mixto (ítem 6.9): ver `BY_METHOD_PIPELINE`.
              byMethod: BY_METHOD_PIPELINE,
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
                // Holgura para el neteo de devoluciones: el top 10 se recorta
                // después de restarlas.
                { $limit: 50 },
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
        .exec(),
      this.saleReturns
        .aggregate([{ $match: returnsMatch }, { $facet: RETURNS_FACET }])
        .exec(),
    ])) as [
      {
        days: { _id: string; revenue: number; tax: number; tickets: number }[];
        byMethod: {
          _id: string;
          revenue: number;
          collected: number;
          tickets: number;
        }[];
        bySede: { _id: Types.ObjectId; revenue: number; tickets: number }[];
        topProducts: {
          _id: Types.ObjectId;
          name: string;
          qty: number;
          revenue: number;
        }[];
        totals: { revenue: number; tax: number; tickets: number }[];
      }[],
      RetornosFacet[],
    ];

    const byMethod = (facet?.byMethod ?? []).map((r) => ({
      method: r._id ?? 'desconocido',
      revenue: r.revenue,
      collected: r.collected,
      tickets: r.tickets,
    }));
    const neto = netearVentas(facet, retornos);
    return {
      from: query.from,
      to: query.to,
      sedeId: query.sedeId ?? null,
      byMethod,
      ...neto,
    };
  }

  /**
   * Las líneas de un tipo de cuenta, con el saldo CON SIGNO en su lado natural.
   *
   * Antes se tomaba el valor absoluto, y eso volteaba las cuentas de saldo
   * contrario: la 4175 (devoluciones en ventas, saldo débito dentro de los
   * ingresos) SUMABA al ingreso en vez de restarle, y la 7205/7305 (costos
   * absorbidos, saldo crédito) sumaban al gasto. Con $10.000.000 vendidos y
   * $2.000.000 devueltos el estado de resultados decía $12.000.000 de
   * ingresos y el balance general dejaba de cuadrar. Un IVA a favor (2408 con
   * saldo débito) salía como pasivo positivo por la misma razón.
   */
  private linesOf(rows: TrialBalanceRow[], type: string): StatementLine[] {
    return rows
      .filter((r) => r.type === type)
      .map((r) => ({ code: r.code, name: r.name, amount: r.balance }))
      .filter((l) => l.amount !== 0);
  }

  private sum(lines: StatementLine[]): number {
    return lines.reduce((a, l) => a + l.amount, 0);
  }
}
