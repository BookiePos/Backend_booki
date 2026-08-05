import { Model, Types } from 'mongoose';
import { SaleDocument } from '../../sales/infrastructure/schemas/sale.schema';
import { PayrollRunDocument } from '../../payroll/infrastructure/schemas/payroll-run.schema';
import { FinanceExpenseDocument } from '../infrastructure/schemas/finance-expense.schema';
import { CategoryKind } from './finance.constants';
import { cop } from './money.util';

/** Rango de fechas inclusivo en formato YYYY-MM-DD. */
export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD (inclusive)
}

/** Modelos que necesita el cálculo del "Real". */
export interface ActualsModels {
  sales: Model<SaleDocument>;
  runs: Model<PayrollRunDocument>;
  expenses: Model<FinanceExpenseDocument>;
}

/** Convierte 'YYYY-MM-DD' a Date de inicio de día (hora local). */
function startOfDay(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00`);
}

/** Convierte 'YYYY-MM-DD' (inclusivo) al inicio del día SIGUIENTE. */
function endExclusive(dateStr: string): Date {
  return new Date(startOfDay(dateStr).getTime() + 24 * 60 * 60 * 1000);
}

/** Filtro de sede reutilizable: si hay sedeIds, restringe; si null, no filtra. */
function sedeMatch(sedeIds: string[] | null): Record<string, unknown> {
  if (!sedeIds || sedeIds.length === 0) return {};
  return { sedeId: { $in: sedeIds.map((id) => new Types.ObjectId(id)) } };
}

/** ¿El período YYYY-MM de una corrida cae dentro del rango YYYY-MM-DD? */
function periodInRange(period: string, range: DateRange): boolean {
  const fromMonth = range.from.slice(0, 7); // YYYY-MM
  const toMonth = range.to.slice(0, 7);
  return period >= fromMonth && period <= toMonth;
}

/** Σ base gravable (neto sin IVA) de las ventas completadas del rango+sede. */
async function incomeActual(
  models: ActualsModels,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<number> {
  const sales = await models.sales
    .find({
      status: 'completed',
      createdAt: { $gte: startOfDay(range.from), $lt: endExclusive(range.to) },
      ...sedeMatch(sedeIds),
    })
    .select('taxableBase')
    .exec();
  return cop(sales.reduce((a, s) => a + (s.taxableBase || 0), 0));
}

/** Σ costo de los `components[]` (COGS FEFO) de las ventas del rango+sede. */
async function cogsActual(
  models: ActualsModels,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<number> {
  const sales = await models.sales
    .find({
      status: 'completed',
      createdAt: { $gte: startOfDay(range.from), $lt: endExclusive(range.to) },
      ...sedeMatch(sedeIds),
    })
    .select('components.cost')
    .exec();
  let total = 0;
  for (const s of sales) {
    for (const c of s.components ?? []) total += c.cost || 0;
  }
  return cop(total);
}

/**
 * Σ `payroll_runs.totals.costo` cuyos `period` caen en el rango. Si es por sede
 * (sedeIds no nulo), solo cuenta runs con coverage 'sede' de esas sedes; si es
 * consolidado (sedeIds null), suma todas las corridas del período.
 */
/** ¿La corrida `a` es la que debe contar frente a `b` (mismo período+sede)? */
function betterRun(a: PayrollRunDocument, b: PayrollRunDocument): boolean {
  // Preferir la cerrada sobre el borrador; a igualdad, la más reciente.
  const closedA = a.status === 'cerrada';
  const closedB = b.status === 'cerrada';
  if (closedA !== closedB) return closedA;
  const ta = (a as unknown as { createdAt?: Date }).createdAt?.getTime() ?? 0;
  const tb = (b as unknown as { createdAt?: Date }).createdAt?.getTime() ?? 0;
  return ta > tb;
}

async function payrollActual(
  models: ActualsModels,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<number> {
  const runs = await models.runs
    .find({})
    .select('period sedeId coverage status createdAt totals.costo')
    .exec();
  const allowed = sedeIds ? new Set(sedeIds) : null;

  // Puede haber varias corridas del mismo período (p. ej. al regenerar sin
  // borrar la anterior). Se cuenta UNA sola por período+cobertura+sede (la
  // cerrada; si no, la más reciente), para no duplicar el costo de nómina.
  const chosen = new Map<string, PayrollRunDocument>();
  for (const r of runs) {
    if (!periodInRange(r.period, range)) continue;
    if (allowed) {
      // Por sede: solo corridas de una sede concreta incluida en el alcance.
      if (r.coverage !== 'sede') continue;
      if (!r.sedeId || !allowed.has(r.sedeId.toString())) continue;
    }
    const key = `${r.period}|${r.coverage}|${r.sedeId ? r.sedeId.toString() : ''}`;
    const prev = chosen.get(key);
    if (!prev || betterRun(r, prev)) chosen.set(key, r);
  }

  let total = 0;
  for (const r of chosen.values()) total += r.totals?.costo || 0;
  return cop(total);
}

/** Σ `finance_expenses.amount` de una categoría en el rango+sede. */
async function expenseActual(
  models: ActualsModels,
  categoryId: string | null,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<number> {
  const filter: Record<string, unknown> = {
    date: { $gte: range.from, $lte: range.to },
    ...sedeMatch(sedeIds),
  };
  if (categoryId) filter.categoryId = new Types.ObjectId(categoryId);
  const expenses = await models.expenses.find(filter).select('amount').exec();
  return cop(expenses.reduce((a, e) => a + (e.amount || 0), 0));
}

/** Σ IVA generado (ventas) − Σ IVA descontable (gastos) del rango+sede. */
async function taxActual(
  models: ActualsModels,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<number> {
  const [sales, expenses] = await Promise.all([
    models.sales
      .find({
        status: 'completed',
        createdAt: {
          $gte: startOfDay(range.from),
          $lt: endExclusive(range.to),
        },
        ...sedeMatch(sedeIds),
      })
      .select('taxTotal')
      .exec(),
    models.expenses
      .find({ date: { $gte: range.from, $lte: range.to }, ...sedeMatch(sedeIds) })
      .select('taxAmount')
      .exec(),
  ]);
  const generado = sales.reduce((a, s) => a + (s.taxTotal || 0), 0);
  const descontable = expenses.reduce((a, e) => a + (e.taxAmount || 0), 0);
  return cop(generado - descontable);
}

/**
 * "Real" de una categoría en un rango+sede. Reutilizado por el P&L y por el
 * comparativo presupuesto vs real.
 * - income → Σ ventas.taxableBase (neto sin IVA)
 * - cogs   → Σ costo de components[]
 * - payroll→ Σ payroll_runs.totals.costo del período
 * - expense→ Σ finance_expenses.amount de la categoría
 * - tax    → Σ IVA ventas − Σ IVA gastos
 * - other  → 0 (sin fuente automática)
 */
export async function actualForCategory(
  models: ActualsModels,
  kind: CategoryKind,
  categoryId: string | null,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<number> {
  switch (kind) {
    case 'income':
      return incomeActual(models, range, sedeIds);
    case 'cogs':
      return cogsActual(models, range, sedeIds);
    case 'payroll':
      return payrollActual(models, range, sedeIds);
    case 'expense':
      return expenseActual(models, categoryId, range, sedeIds);
    case 'tax':
      return taxActual(models, range, sedeIds);
    case 'other':
    default:
      return 0;
  }
}

/** Expone los helpers de rango para el service (P&L, overview). */
export const actualsRange = { startOfDay, endExclusive };
