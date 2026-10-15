import { Model, Types } from 'mongoose';
import { SaleDocument } from '../../sales/infrastructure/schemas/sale.schema';
import { PayrollRunDocument } from '../../payroll/infrastructure/schemas/payroll-run.schema';
import { FinanceExpenseDocument } from '../infrastructure/schemas/finance-expense.schema';
import { CategoryKind } from './finance.constants';
import { cop, sumBy } from './money.util';

/**
 * Diferencia conocida con el libro (checklist 1.13). El «Real» sale de los
 * documentos operativos en su estado ACTUAL: una venta anulada o un gasto
 * borrado no cuenta en ningún mes, y un gasto editado cuenta con sus datos
 * nuevos en su fecha. El libro, en cambio, reversa en el período en que se
 * anula (C. Co. art. 57; E.T. art. 484; ver `fechaDeReversa` en
 * `core-ledger/domain/fecha-contable.ts`): si el original es de un mes
 * anterior, ese mes conserva la operación y el mes de la anulación lleva la
 * reversa. Dentro del mismo mes coinciden.
 *
 * Por eso, cuando se anula o corrige algo de un mes anterior, el P&L del mes
 * original muestra menos que el libro y el del mes de la anulación muestra
 * más, por el mismo valor: el acumulado de los dos meses coincide. Igualarlos
 * mes a mes exige guardar cuándo se anuló cada venta y el histórico de cada
 * gasto (hoy no existen), o leer el P&L del libro. Para declarar, manda el
 * libro.
 */
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
  /**
   * Si la sede descuenta el IVA de sus gastos (arts. 437 y 488 ET). Lo resuelve
   * `ivaDescontablePorSede` (core-tax) con el mismo perfil que la venta.
   */
  admiteIvaDescontable: (sedeId?: string) => boolean;
  /**
   * Σ IVA descontable de las recepciones de compra del rango+sede. Sale del
   * libro (débitos a la 2408 de `purchase_receipt`, netos de sus reversas):
   * la recepción no guarda su IVA en otro documento.
   */
  ivaDescontableDeCompras: (range: DateRange, sedeIds: string[] | null) => Promise<number>;
}

/**
 * Lo que un gasto pesa en resultados: la base y, si su sede NO descuenta el
 * IVA (no responsable o restaurante con INC, arts. 437 y 488 ET), también el
 * IVA, que es mayor valor del gasto. Mismo criterio que su asiento.
 */
export function costoDelGasto(
  admiteIvaDescontable: ActualsModels['admiteIvaDescontable'],
  e: { amount?: number; taxAmount?: number; sedeId?: { toString(): string } },
): number {
  const iva = admiteIvaDescontable(e.sedeId?.toString()) ? 0 : e.taxAmount || 0;
  return (e.amount || 0) + iva;
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

/** Σ costo de los gastos de una categoría en el rango+sede (ver `costoDelGasto`). */
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
  const expenses = await models.expenses
    .find(filter)
    .select('amount taxAmount sedeId')
    .exec();
  return sumBy(expenses, (e) => costoDelGasto(models.admiteIvaDescontable, e));
}

/**
 * IVA e INC generados por las ventas completadas del rango+sede, por separado.
 *
 * `taxTotal` mezcla los dos: un restaurante causa INC (cuenta 2495), no IVA
 * (2408), y se declaran en formularios distintos. El INC se toma de las líneas
 * con `taxKind: 'inc'`; el resto del impuesto es IVA, incluidas las líneas sin
 * `taxKind` (ventas anteriores a ese campo, que eran IVA) y las `ninguno`, que
 * llevan impuesto 0. Ambos se acumulan sin redondear y se cierran con `cop()`
 * al final, con el mismo criterio.
 */
export async function ivaEIncDeVentas(
  models: ActualsModels,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<{ iva: number; inc: number }> {
  const sales = await models.sales
    .find({
      status: 'completed',
      createdAt: { $gte: startOfDay(range.from), $lt: endExclusive(range.to) },
      ...sedeMatch(sedeIds),
    })
    .select('taxTotal lines.taxKind lines.taxAmount')
    .exec();
  let iva = 0;
  let inc = 0;
  for (const s of sales) {
    const incVenta = (s.lines ?? [])
      .filter((l) => l.taxKind === 'inc')
      .reduce((a, l) => a + (l.taxAmount || 0), 0);
    inc += incVenta;
    iva += (s.taxTotal || 0) - incVenta;
  }
  return { iva: cop(iva), inc: cop(inc) };
}

/**
 * Σ IVA pagado en los gastos del rango+sede que es descontable. Quien no es
 * responsable de IVA, o causa INC en vez de IVA, no tiene IVA descontable
 * (arts. 437 y 488 ET): para esas sedes el IVA del gasto es mayor valor del
 * gasto y no se resta de nada. Sin esto, un restaurante mostraba un saldo de
 * IVA «a favor» que no existe.
 */
export async function ivaDescontableDeGastos(
  models: ActualsModels,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<number> {
  const expenses = await models.expenses
    .find({ date: { $gte: range.from, $lte: range.to }, ...sedeMatch(sedeIds) })
    .select('taxAmount sedeId')
    .exec();
  return sumBy(
    expenses.filter((e) => models.admiteIvaDescontable(e.sedeId?.toString())),
    (e) => e.taxAmount || 0,
  );
}

/**
 * Σ IVA descontable del rango+sede: el de los gastos y el de las compras. Es
 * lo mismo que el libro debita a la 2408 por esos dos eventos.
 */
export async function ivaDescontableTotal(
  models: ActualsModels,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<number> {
  const [gastos, compras] = await Promise.all([
    ivaDescontableDeGastos(models, range, sedeIds),
    models.ivaDescontableDeCompras(range, sedeIds),
  ]);
  return cop(gastos + compras);
}

/**
 * Σ IVA generado (ventas) − Σ IVA descontable (gastos y compras) del
 * rango+sede. Solo IVA: el INC no es parte de la categoría IVA (2408) ni
 * admite descontables.
 */
async function taxActual(
  models: ActualsModels,
  range: DateRange,
  sedeIds: string[] | null,
): Promise<number> {
  const [generado, descontable] = await Promise.all([
    ivaEIncDeVentas(models, range, sedeIds),
    ivaDescontableTotal(models, range, sedeIds),
  ]);
  return cop(generado.iva - descontable);
}

/**
 * "Real" de una categoría en un rango+sede. Reutilizado por el P&L y por el
 * comparativo presupuesto vs real.
 * - income → Σ ventas.taxableBase (neto sin IVA)
 * - cogs   → Σ costo de components[]
 * - payroll→ Σ payroll_runs.totals.costo del período
 * - expense→ Σ costo de los gastos de la categoría (con el IVA no descontable)
 * - tax    → Σ IVA ventas (sin el INC) − Σ IVA descontable (gastos y compras)
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
