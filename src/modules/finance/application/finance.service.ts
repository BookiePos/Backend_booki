import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  FinanceCategory,
  FinanceCategoryDocument,
} from '../infrastructure/schemas/finance-category.schema';
import {
  FinanceExpense,
  FinanceExpenseDocument,
} from '../infrastructure/schemas/finance-expense.schema';
import {
  FinancePayable,
  FinancePayableDocument,
} from '../infrastructure/schemas/finance-payable.schema';
import {
  FinanceAccount,
  FinanceAccountDocument,
} from '../infrastructure/schemas/finance-account.schema';
import {
  FinanceMovement,
  FinanceMovementDocument,
} from '../infrastructure/schemas/finance-movement.schema';
import {
  FinanceBudget,
  FinanceBudgetDocument,
} from '../infrastructure/schemas/finance-budget.schema';
import { Sale, SaleDocument } from '../../sales/infrastructure/schemas/sale.schema';
import {
  PayrollRun,
  PayrollRunDocument,
} from '../../payroll/infrastructure/schemas/payroll-run.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';
import { CajaService } from '../../caja/application/caja.service';
import {
  CategoryKind,
  ExpenseStatus,
  PayableStatus,
  SEED_CATEGORIES,
} from '../domain/finance.constants';
import { clampNonNegative, cop } from '../domain/money.util';
import {
  actualForCategory,
  ActualsModels,
  DateRange,
} from '../domain/actuals';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import {
  CreatePayableDto,
  CreatePayablePaymentDto,
} from './dto/payable.dto';
import { CreateAccountDto, CreateMovementDto } from './dto/account.dto';
import { CreateBudgetDto, UpdateBudgetDto } from './dto/budget.dto';

/** Fila del P&L (una línea de gasto por categoría). */
export interface PLRow {
  categoryId?: string;
  label: string;
  amount: number;
}

/** Reporte de Pérdidas y Ganancias del rango. */
export interface PLReport {
  from: string;
  to: string;
  sedeId?: string | null;
  ingresos: number;
  cogs: number;
  margenBruto: number;
  nomina: number;
  gastos: PLRow[];
  gastosTotal: number;
  utilidadOperativa: number;
  ivaGenerado: number;
  ivaDescontable: number;
  ivaPorPagar: number;
}

/** KPIs del panel de finanzas. */
export interface FinanceOverview {
  sedeId?: string | null;
  cashToday: number;
  salesMonth: number;
  expensesMonth: number;
  payablesOpen: number;
  payablesOverdue: number;
  utilidadMonth: number;
}

/** Línea del comparativo presupuesto vs real. */
export interface BudgetVsActualLine {
  categoryId: string;
  categoryName: string;
  kind: CategoryKind;
  monthlyBudget: number[];
  monthlyActual: number[];
  totalBudget: number;
  totalActual: number;
}

export interface BudgetVsActual {
  budgetId: string;
  fiscalYear: number;
  sedeId?: string | null;
  lines: BudgetVsActualLine[];
  totals: { budget: number; actual: number };
}

/** Cuenta de tesorería con su saldo calculado (apertura + Σ movimientos). */
export type FinanceAccountWithBalance = FinanceAccount & {
  _id: Types.ObjectId;
  balance: number;
};

@Injectable()
export class FinanceService {
  constructor(
    @InjectModel(FinanceCategory.name)
    private readonly categories: Model<FinanceCategoryDocument>,
    @InjectModel(FinanceExpense.name)
    private readonly expenses: Model<FinanceExpenseDocument>,
    @InjectModel(FinancePayable.name)
    private readonly payables: Model<FinancePayableDocument>,
    @InjectModel(FinanceAccount.name)
    private readonly accounts: Model<FinanceAccountDocument>,
    @InjectModel(FinanceMovement.name)
    private readonly movements: Model<FinanceMovementDocument>,
    @InjectModel(FinanceBudget.name)
    private readonly budgets: Model<FinanceBudgetDocument>,
    @InjectModel(Sale.name)
    private readonly sales: Model<SaleDocument>,
    @InjectModel(PayrollRun.name)
    private readonly runs: Model<PayrollRunDocument>,
    private readonly caja: CajaService,
  ) {}

  private actualsModels(): ActualsModels {
    return { sales: this.sales, runs: this.runs, expenses: this.expenses };
  }

  // ── Utilidades de sede / fechas ────────────────────────────────────────────

  /**
   * Resuelve el alcance de sedes para una consulta de lectura. Si el usuario
   * pide una sede concreta, la valida; si no, devuelve las sedes permitidas
   * (null = dueño ve todo → sin filtro).
   */
  private resolveSedeScope(user: JwtUser, sedeId?: string): string[] | null {
    if (sedeId) {
      assertSedeAccess(user, sedeId);
      return [sedeId];
    }
    return allowedSedeIds(user);
  }

  /** Primer y último día del mes actual (YYYY-MM-DD). */
  private currentMonthRange(): DateRange {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    return { from: this.toDateStr(first), to: this.toDateStr(last) };
  }

  private toDateStr(d: Date): string {
    return d.toLocaleDateString('en-CA');
  }

  private todayStr(): string {
    return new Date().toLocaleDateString('en-CA');
  }

  // ── Categorías ─────────────────────────────────────────────────────────────

  /** Siembra el set base de categorías `system` la primera vez (idempotente). */
  private async seedCategories(): Promise<void> {
    const existing = await this.categories.countDocuments({ system: true }).exec();
    if (existing > 0) return;
    await this.categories.insertMany(
      SEED_CATEGORIES.map((c) => ({
        name: c.name,
        kind: c.kind,
        accountCode: c.accountCode,
        autoSource: c.autoSource,
        system: true,
        active: true,
      })),
    );
  }

  async listCategories(): Promise<FinanceCategoryDocument[]> {
    await this.seedCategories();
    return this.categories.find().sort({ kind: 1, name: 1 }).exec();
  }

  async createCategory(
    dto: CreateCategoryDto,
  ): Promise<FinanceCategoryDocument> {
    return this.categories.create({
      name: dto.name,
      kind: dto.kind,
      accountCode: dto.accountCode,
      autoSource: dto.autoSource ?? null,
      system: false,
      active: true,
    });
  }

  async updateCategory(
    id: string,
    dto: UpdateCategoryDto,
  ): Promise<FinanceCategoryDocument> {
    const cat = await this.categories.findById(id).exec();
    if (!cat) throw new NotFoundException('Categoría no encontrada');
    if (dto.name !== undefined) cat.name = dto.name;
    if (dto.accountCode !== undefined) cat.accountCode = dto.accountCode;
    if (dto.active !== undefined) cat.active = dto.active;
    // No se permite cambiar el `kind` de una categoría de sistema (rompe el P&L).
    if (dto.kind !== undefined) {
      if (cat.system) {
        throw new BadRequestException(
          'No se puede cambiar la naturaleza de una categoría de sistema.',
        );
      }
      cat.kind = dto.kind;
    }
    await cat.save();
    return cat;
  }

  private async categoryOrThrow(
    id: string,
  ): Promise<FinanceCategoryDocument> {
    const cat = await this.categories.findById(id).exec();
    if (!cat) throw new NotFoundException('Categoría no encontrada');
    return cat;
  }

  // ── Gastos ─────────────────────────────────────────────────────────────────

  async listExpenses(
    user: JwtUser,
    query: { sedeId?: string; from?: string; to?: string; status?: ExpenseStatus },
  ): Promise<FinanceExpenseDocument[]> {
    const scope = this.resolveSedeScope(user, query.sedeId);
    const filter: Record<string, unknown> = {};
    if (scope) {
      filter.sedeId = { $in: scope.map((id) => new Types.ObjectId(id)) };
    }
    if (query.from || query.to) {
      const range: Record<string, string> = {};
      if (query.from) range.$gte = query.from;
      if (query.to) range.$lte = query.to;
      filter.date = range;
    }
    if (query.status) filter.status = query.status;
    return this.expenses.find(filter).sort({ date: -1, createdAt: -1 }).exec();
  }

  async createExpense(
    dto: CreateExpenseDto,
    user: JwtUser,
  ): Promise<FinanceExpenseDocument> {
    assertSedeAccess(user, dto.sedeId);
    const cat = await this.categoryOrThrow(dto.categoryId);
    return this.expenses.create({
      sedeId: new Types.ObjectId(dto.sedeId),
      categoryId: cat._id,
      categoryName: cat.name,
      concept: dto.concept,
      amount: cop(dto.amount),
      taxAmount: cop(dto.taxAmount ?? 0),
      date: dto.date,
      status: dto.status ?? 'paid',
      paymentMethod: dto.paymentMethod,
      supplierId: dto.supplierId
        ? new Types.ObjectId(dto.supplierId)
        : undefined,
      supplierName: dto.supplierName,
      recurring: dto.recurring ?? false,
      note: dto.note,
      createdByEmail: user.email,
    });
  }

  async updateExpense(
    id: string,
    dto: UpdateExpenseDto,
    user: JwtUser,
  ): Promise<FinanceExpenseDocument> {
    const exp = await this.expenses.findById(id).exec();
    if (!exp) throw new NotFoundException('Gasto no encontrado');
    assertSedeAccess(user, exp.sedeId.toString());
    if (dto.categoryId !== undefined) {
      const cat = await this.categoryOrThrow(dto.categoryId);
      exp.categoryId = cat._id;
      exp.categoryName = cat.name;
    }
    if (dto.concept !== undefined) exp.concept = dto.concept;
    if (dto.amount !== undefined) exp.amount = cop(dto.amount);
    if (dto.taxAmount !== undefined) exp.taxAmount = cop(dto.taxAmount);
    if (dto.date !== undefined) exp.date = dto.date;
    if (dto.status !== undefined) exp.status = dto.status;
    if (dto.paymentMethod !== undefined) exp.paymentMethod = dto.paymentMethod;
    if (dto.supplierId !== undefined) {
      exp.supplierId = dto.supplierId
        ? new Types.ObjectId(dto.supplierId)
        : undefined;
    }
    if (dto.supplierName !== undefined) exp.supplierName = dto.supplierName;
    if (dto.recurring !== undefined) exp.recurring = dto.recurring;
    if (dto.note !== undefined) exp.note = dto.note;
    await exp.save();
    return exp;
  }

  async deleteExpense(id: string, user: JwtUser): Promise<{ deleted: boolean }> {
    const exp = await this.expenses.findById(id).exec();
    if (!exp) throw new NotFoundException('Gasto no encontrado');
    assertSedeAccess(user, exp.sedeId.toString());
    await exp.deleteOne();
    return { deleted: true };
  }

  // ── Cuentas por pagar ───────────────────────────────────────────────────────

  async listPayables(
    user: JwtUser,
    query: { sedeId?: string; status?: PayableStatus },
  ): Promise<FinancePayableDocument[]> {
    const scope = this.resolveSedeScope(user, query.sedeId);
    const filter: Record<string, unknown> = {};
    if (scope) {
      filter.sedeId = { $in: scope.map((id) => new Types.ObjectId(id)) };
    }
    if (query.status) filter.status = query.status;
    return this.payables.find(filter).sort({ dueDate: 1 }).exec();
  }

  async createPayable(
    dto: CreatePayableDto,
    user: JwtUser,
  ): Promise<FinancePayableDocument> {
    assertSedeAccess(user, dto.sedeId);
    if (dto.categoryId) await this.categoryOrThrow(dto.categoryId);
    return this.payables.create({
      sedeId: new Types.ObjectId(dto.sedeId),
      supplierId: dto.supplierId
        ? new Types.ObjectId(dto.supplierId)
        : undefined,
      supplierName: dto.supplierName,
      categoryId: dto.categoryId
        ? new Types.ObjectId(dto.categoryId)
        : undefined,
      docNumber: dto.docNumber,
      issueDate: dto.issueDate,
      dueDate: dto.dueDate,
      amount: cop(dto.amount),
      paidAmount: 0,
      status: 'open',
      payments: [],
      note: dto.note,
      createdByEmail: user.email,
    });
  }

  async addPayablePayment(
    id: string,
    dto: CreatePayablePaymentDto,
    user: JwtUser,
  ): Promise<FinancePayableDocument> {
    const payable = await this.payables.findById(id).exec();
    if (!payable) throw new NotFoundException('Cuenta por pagar no encontrada');
    assertSedeAccess(user, payable.sedeId.toString());
    if (payable.status === 'void') {
      throw new BadRequestException('La cuenta por pagar está anulada.');
    }
    const amount = cop(dto.amount);
    if (amount <= 0) {
      throw new BadRequestException('El abono debe ser mayor a cero.');
    }
    const newPaid = payable.paidAmount + amount;
    if (newPaid > payable.amount) {
      throw new BadRequestException(
        'El abono excede el saldo pendiente de la cuenta.',
      );
    }
    payable.payments.push({
      date: dto.date,
      amount,
      method: dto.method,
      note: dto.note,
      userEmail: user.email,
    });
    payable.paidAmount = newPaid;
    payable.status = this.payableStatus(payable.amount, newPaid);
    await payable.save();
    return payable;
  }

  /** Recalcula el estado de una CxP según abonado vs total. */
  private payableStatus(amount: number, paid: number): PayableStatus {
    if (paid <= 0) return 'open';
    if (paid >= amount) return 'paid';
    return 'partial';
  }

  // ── Cuentas de tesorería y movimientos ──────────────────────────────────────

  async listAccounts(user: JwtUser): Promise<FinanceAccountWithBalance[]> {
    const scope = allowedSedeIds(user);
    const filter: Record<string, unknown> = {};
    if (scope) {
      // El usuario ve cuentas de sus sedes + las consolidadas (sin sede).
      filter.$or = [
        { sedeId: { $in: scope.map((id) => new Types.ObjectId(id)) } },
        { sedeId: null },
      ];
    }
    const accounts = await this.accounts.find(filter).sort({ name: 1 }).exec();
    const result: FinanceAccountWithBalance[] = [];
    for (const acc of accounts) {
      const balance = await this.accountBalance(acc);
      const obj = acc.toObject<FinanceAccount & { _id: Types.ObjectId }>();
      result.push({ ...obj, balance });
    }
    return result;
  }

  /** Saldo = apertura + Σ entradas − Σ salidas. */
  private async accountBalance(acc: FinanceAccountDocument): Promise<number> {
    const movements = await this.movements
      .find({ accountId: acc._id })
      .select('direction amount')
      .exec();
    const delta = movements.reduce(
      (a, m) => a + (m.direction === 'in' ? m.amount : -m.amount),
      0,
    );
    return cop(acc.openingBalance + delta);
  }

  async createAccount(
    dto: CreateAccountDto,
    user: JwtUser,
  ): Promise<FinanceAccountDocument> {
    if (dto.sedeId) assertSedeAccess(user, dto.sedeId);
    return this.accounts.create({
      sedeId: dto.sedeId ? new Types.ObjectId(dto.sedeId) : null,
      name: dto.name,
      type: dto.type,
      openingBalance: cop(dto.openingBalance ?? 0),
      active: true,
      note: dto.note,
    });
  }

  private async accountOrThrow(
    id: string,
    user: JwtUser,
  ): Promise<FinanceAccountDocument> {
    const acc = await this.accounts.findById(id).exec();
    if (!acc) throw new NotFoundException('Cuenta no encontrada');
    if (acc.sedeId) assertSedeAccess(user, acc.sedeId.toString());
    return acc;
  }

  async listMovements(
    accountId: string,
    user: JwtUser,
    query: { from?: string; to?: string },
  ): Promise<FinanceMovementDocument[]> {
    const acc = await this.accountOrThrow(accountId, user);
    const filter: Record<string, unknown> = { accountId: acc._id };
    if (query.from || query.to) {
      const range: Record<string, string> = {};
      if (query.from) range.$gte = query.from;
      if (query.to) range.$lte = query.to;
      filter.date = range;
    }
    return this.movements.find(filter).sort({ date: -1, createdAt: -1 }).exec();
  }

  async createMovement(
    accountId: string,
    dto: CreateMovementDto,
    user: JwtUser,
  ): Promise<FinanceMovementDocument> {
    const acc = await this.accountOrThrow(accountId, user);
    if (dto.categoryId) await this.categoryOrThrow(dto.categoryId);
    return this.movements.create({
      accountId: acc._id,
      sedeId: acc.sedeId ?? null,
      date: dto.date,
      direction: dto.direction,
      amount: cop(dto.amount),
      categoryId: dto.categoryId
        ? new Types.ObjectId(dto.categoryId)
        : undefined,
      concept: dto.concept,
      reconciled: false,
      createdByEmail: user.email,
    });
  }

  // ── Presupuestos ─────────────────────────────────────────────────────────────

  async listBudgets(
    user: JwtUser,
    fiscalYear?: number,
  ): Promise<FinanceBudgetDocument[]> {
    const scope = allowedSedeIds(user);
    const filter: Record<string, unknown> = {};
    if (fiscalYear) filter.fiscalYear = fiscalYear;
    if (scope) {
      filter.$or = [
        { sedeId: { $in: scope.map((id) => new Types.ObjectId(id)) } },
        { sedeId: null },
      ];
    }
    return this.budgets.find(filter).sort({ fiscalYear: -1, name: 1 }).exec();
  }

  async getBudget(id: string, user: JwtUser): Promise<FinanceBudgetDocument> {
    const budget = await this.budgets.findById(id).exec();
    if (!budget) throw new NotFoundException('Presupuesto no encontrado');
    if (budget.sedeId) assertSedeAccess(user, budget.sedeId.toString());
    return budget;
  }

  async createBudget(
    dto: CreateBudgetDto,
    user: JwtUser,
  ): Promise<FinanceBudgetDocument> {
    if (dto.sedeId) assertSedeAccess(user, dto.sedeId);
    return this.budgets.create({
      name: dto.name,
      fiscalYear: dto.fiscalYear,
      sedeId: dto.sedeId ? new Types.ObjectId(dto.sedeId) : null,
      scenario: dto.scenario ?? 'base',
      status: dto.status ?? 'draft',
      lines: (dto.lines ?? []).map((l) => ({
        categoryId: new Types.ObjectId(l.categoryId),
        categoryName: l.categoryName,
        kind: l.kind,
        monthly: this.normalizeMonthly(l.monthly),
      })),
      createdByEmail: user.email,
    });
  }

  async updateBudget(
    id: string,
    dto: UpdateBudgetDto,
    user: JwtUser,
  ): Promise<FinanceBudgetDocument> {
    const budget = await this.getBudget(id, user);
    if (dto.name !== undefined) budget.name = dto.name;
    if (dto.scenario !== undefined) budget.scenario = dto.scenario;
    if (dto.status !== undefined) budget.status = dto.status;
    if (dto.lines !== undefined) {
      budget.lines = dto.lines.map((l) => ({
        categoryId: new Types.ObjectId(l.categoryId),
        categoryName: l.categoryName,
        kind: l.kind,
        monthly: this.normalizeMonthly(l.monthly),
      }));
    }
    await budget.save();
    return budget;
  }

  async deleteBudget(
    id: string,
    user: JwtUser,
  ): Promise<{ deleted: boolean }> {
    const budget = await this.getBudget(id, user);
    await budget.deleteOne();
    return { deleted: true };
  }

  /** Asegura 12 montos enteros por línea (rellena/recorta si hace falta). */
  private normalizeMonthly(monthly: number[]): number[] {
    const out = Array(12).fill(0);
    for (let i = 0; i < 12; i += 1) out[i] = cop(monthly[i] ?? 0);
    return out;
  }

  async budgetVsActual(
    id: string,
    user: JwtUser,
    sedeId?: string,
  ): Promise<BudgetVsActual> {
    const budget = await this.getBudget(id, user);
    // Alcance de sedes para el "Real": el query manda; si no, el del presupuesto;
    // si es consolidado (null), sin filtro.
    let sedeScope: string[] | null;
    if (sedeId) {
      assertSedeAccess(user, sedeId);
      sedeScope = [sedeId];
    } else if (budget.sedeId) {
      sedeScope = [budget.sedeId.toString()];
    } else {
      sedeScope = null;
    }

    const lines: BudgetVsActualLine[] = [];
    let totalBudget = 0;
    let totalActual = 0;

    for (const line of budget.lines) {
      const monthlyBudget = this.normalizeMonthly(line.monthly);
      const monthlyActual: number[] = [];
      for (let month = 0; month < 12; month += 1) {
        const range = this.monthRange(budget.fiscalYear, month);
        const actual = await actualForCategory(
          this.actualsModels(),
          line.kind,
          line.categoryId.toString(),
          range,
          sedeScope,
        );
        monthlyActual.push(actual);
      }
      const lineBudget = monthlyBudget.reduce((a, n) => a + n, 0);
      const lineActual = monthlyActual.reduce((a, n) => a + n, 0);
      totalBudget += lineBudget;
      totalActual += lineActual;
      lines.push({
        categoryId: line.categoryId.toString(),
        categoryName: line.categoryName,
        kind: line.kind,
        monthlyBudget,
        monthlyActual,
        totalBudget: cop(lineBudget),
        totalActual: cop(lineActual),
      });
    }

    return {
      budgetId: budget._id.toString(),
      fiscalYear: budget.fiscalYear,
      sedeId: budget.sedeId ? budget.sedeId.toString() : null,
      lines,
      totals: { budget: cop(totalBudget), actual: cop(totalActual) },
    };
  }

  /** Rango YYYY-MM-DD del mes `month` (0..11) de un año. */
  private monthRange(year: number, month: number): DateRange {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    return { from: this.toDateStr(first), to: this.toDateStr(last) };
  }

  // ── Reportes: P&L y Overview ────────────────────────────────────────────────

  async profitAndLoss(
    user: JwtUser,
    from: string,
    to: string,
    sedeId?: string,
  ): Promise<PLReport> {
    if (!from || !to) {
      throw new BadRequestException('from y to son obligatorios (YYYY-MM-DD).');
    }
    const scope = this.resolveSedeScope(user, sedeId);
    const range: DateRange = { from, to };
    const models = this.actualsModels();

    const ingresos = await actualForCategory(models, 'income', null, range, scope);
    const cogs = await actualForCategory(models, 'cogs', null, range, scope);
    const nomina = await actualForCategory(models, 'payroll', null, range, scope);

    // Gastos por categoría (kind='expense'), una fila por categoría con monto > 0.
    const expenseCats = await this.categories.find({ kind: 'expense' }).exec();
    const gastos: PLRow[] = [];
    let gastosTotal = 0;
    for (const cat of expenseCats) {
      const amount = await actualForCategory(
        models,
        'expense',
        cat._id.toString(),
        range,
        scope,
      );
      if (amount > 0) {
        gastos.push({
          categoryId: cat._id.toString(),
          label: cat.name,
          amount,
        });
        gastosTotal += amount;
      }
    }
    gastos.sort((a, b) => b.amount - a.amount);

    // IVA: generado (ventas) y descontable (gastos) por separado, para el detalle.
    const ivaGenerado = await this.ivaGenerado(range, scope);
    const ivaDescontable = await this.ivaDescontable(range, scope);

    const margenBruto = cop(ingresos - cogs);
    const utilidadOperativa = cop(margenBruto - nomina - gastosTotal);

    return {
      from,
      to,
      sedeId: sedeId ?? null,
      ingresos,
      cogs,
      margenBruto,
      nomina,
      gastos,
      gastosTotal: cop(gastosTotal),
      utilidadOperativa,
      ivaGenerado,
      ivaDescontable,
      ivaPorPagar: cop(ivaGenerado - ivaDescontable),
    };
  }

  private async ivaGenerado(
    range: DateRange,
    scope: string[] | null,
  ): Promise<number> {
    const filter: Record<string, unknown> = {
      status: 'completed',
      createdAt: {
        $gte: new Date(`${range.from}T00:00:00`),
        $lt: new Date(
          new Date(`${range.to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000,
        ),
      },
    };
    if (scope) {
      filter.sedeId = { $in: scope.map((id) => new Types.ObjectId(id)) };
    }
    const sales = await this.sales.find(filter).select('taxTotal').exec();
    return cop(sales.reduce((a, s) => a + (s.taxTotal || 0), 0));
  }

  private async ivaDescontable(
    range: DateRange,
    scope: string[] | null,
  ): Promise<number> {
    const filter: Record<string, unknown> = {
      date: { $gte: range.from, $lte: range.to },
    };
    if (scope) {
      filter.sedeId = { $in: scope.map((id) => new Types.ObjectId(id)) };
    }
    const expenses = await this.expenses.find(filter).select('taxAmount').exec();
    return cop(expenses.reduce((a, e) => a + (e.taxAmount || 0), 0));
  }

  async overview(user: JwtUser, sedeId?: string): Promise<FinanceOverview> {
    const scope = this.resolveSedeScope(user, sedeId);
    const range = this.currentMonthRange();
    const models = this.actualsModels();

    const salesMonth = await actualForCategory(models, 'income', null, range, scope);
    const cogs = await actualForCategory(models, 'cogs', null, range, scope);
    const nomina = await actualForCategory(models, 'payroll', null, range, scope);

    // Gastos del mes: Σ de todos los gastos del rango+sede.
    const expenseFilter: Record<string, unknown> = {
      date: { $gte: range.from, $lte: range.to },
    };
    if (scope) {
      expenseFilter.sedeId = { $in: scope.map((id) => new Types.ObjectId(id)) };
    }
    const monthExpenses = await this.expenses
      .find(expenseFilter)
      .select('amount')
      .exec();
    const expensesMonth = cop(
      monthExpenses.reduce((a, e) => a + (e.amount || 0), 0),
    );

    // CxP abiertas / vencidas.
    const payableFilter: Record<string, unknown> = {
      status: { $in: ['open', 'partial'] },
    };
    if (scope) {
      payableFilter.sedeId = { $in: scope.map((id) => new Types.ObjectId(id)) };
    }
    const openPayables = await this.payables
      .find(payableFilter)
      .select('amount paidAmount dueDate')
      .exec();
    const today = this.todayStr();
    let payablesOpen = 0;
    let payablesOverdue = 0;
    for (const p of openPayables) {
      const pending = clampNonNegative(p.amount - p.paidAmount);
      payablesOpen += pending;
      if (p.dueDate < today) payablesOverdue += pending;
    }

    // Efectivo del día: del módulo de Caja (suma de efectivo esperado hoy).
    const cashToday = await this.cashTodayFromCaja(user, sedeId);

    const utilidadMonth = cop(salesMonth - cogs - nomina - expensesMonth);

    return {
      sedeId: sedeId ?? null,
      cashToday,
      salesMonth,
      expensesMonth,
      payablesOpen: cop(payablesOpen),
      payablesOverdue: cop(payablesOverdue),
      utilidadMonth,
    };
  }

  /** Efectivo esperado hoy en las cajas visibles (o de la sede pedida). */
  private async cashTodayFromCaja(
    user: JwtUser,
    sedeId?: string,
  ): Promise<number> {
    const ov = await this.caja.overview(user);
    const rows = sedeId ? ov.rows.filter((r) => r.sedeId === sedeId) : ov.rows;
    return cop(rows.reduce((a, r) => a + (r.expectedCash ?? 0), 0));
  }
}
