import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { FinanceService } from '../application/finance.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
} from '../application/dto/category.dto';
import {
  CreateExpenseDto,
  UpdateExpenseDto,
} from '../application/dto/expense.dto';
import {
  CreatePayableDto,
  CreatePayablePaymentDto,
} from '../application/dto/payable.dto';
import {
  CreateRecurringExpenseDto,
  UpdateRecurringExpenseDto,
} from '../application/dto/recurring-expense.dto';
import {
  CreateReceivableDto,
  CreateReceivablePaymentDto,
} from '../application/dto/receivable.dto';
import {
  CreateAccountDto,
  CreateMovementDto,
  ReconcileAccountDto,
} from '../application/dto/account.dto';
import {
  CreateBudgetDto,
  UpdateBudgetDto,
} from '../application/dto/budget.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  ExpenseStatus,
  PayableStatus,
  ReceivableStatus,
} from '../domain/finance.constants';

@Controller('finance')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  // ── Categorías ─────────────────────────────────────────────────────────────
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('categories')
  listCategories() {
    return this.finance.listCategories();
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.finance.createCategory(dto);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.finance.updateCategory(id, dto);
  }

  // ── Gastos ─────────────────────────────────────────────────────────────────
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('expenses')
  listExpenses(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: ExpenseStatus,
  ) {
    return this.finance.listExpenses(user, { sedeId, from, to, status });
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post('expenses')
  createExpense(@Body() dto: CreateExpenseDto, @CurrentUser() user: JwtUser) {
    return this.finance.createExpense(dto, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Patch('expenses/:id')
  updateExpense(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.finance.updateExpense(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Delete('expenses/:id')
  deleteExpense(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.finance.deleteExpense(id, user);
  }

  // ── Gastos recurrentes (plantillas) ─────────────────────────────────────────
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('recurring')
  listRecurring(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('active') active?: string,
  ) {
    return this.finance.listRecurring(user, {
      sedeId,
      active: active === undefined ? undefined : active !== 'false',
    });
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post('recurring')
  createRecurring(
    @Body() dto: CreateRecurringExpenseDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.finance.createRecurring(dto, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post('recurring/run')
  runRecurring(@CurrentUser() user: JwtUser) {
    return this.finance.runRecurring({ user });
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Patch('recurring/:id')
  updateRecurring(
    @Param('id') id: string,
    @Body() dto: UpdateRecurringExpenseDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.finance.updateRecurring(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Delete('recurring/:id')
  deleteRecurring(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.finance.deleteRecurring(id, user);
  }

  // ── Cuentas por pagar ───────────────────────────────────────────────────────
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('payables')
  listPayables(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('status') status?: PayableStatus,
  ) {
    return this.finance.listPayables(user, { sedeId, status });
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post('payables')
  createPayable(@Body() dto: CreatePayableDto, @CurrentUser() user: JwtUser) {
    return this.finance.createPayable(dto, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post('payables/:id/payments')
  addPayablePayment(
    @Param('id') id: string,
    @Body() dto: CreatePayablePaymentDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.finance.addPayablePayment(id, dto, user);
  }

  // ── Cuentas por cobrar (fiado) ──────────────────────────────────────────────
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('receivables')
  listReceivables(
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
    @Query('status') status?: ReceivableStatus,
  ) {
    return this.finance.listReceivables(user, { sedeId, status });
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post('receivables')
  createReceivable(
    @Body() dto: CreateReceivableDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.finance.createReceivable(dto, user);
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post('receivables/:id/payments')
  addReceivablePayment(
    @Param('id') id: string,
    @Body() dto: CreateReceivablePaymentDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.finance.addReceivablePayment(id, dto, user);
  }

  // ── Cuentas de tesorería y movimientos ──────────────────────────────────────
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('accounts')
  listAccounts(@CurrentUser() user: JwtUser) {
    return this.finance.listAccounts(user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('accounts')
  createAccount(@Body() dto: CreateAccountDto, @CurrentUser() user: JwtUser) {
    return this.finance.createAccount(dto, user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('accounts/:id/movements')
  listMovements(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.finance.listMovements(id, user, { from, to });
  }

  @RequirePermissions(PERMISSIONS.PURCHASING_MANAGE)
  @Post('accounts/:id/movements')
  createMovement(
    @Param('id') id: string,
    @Body() dto: CreateMovementDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.finance.createMovement(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('accounts/:id/reconcile')
  reconcileAccount(
    @Param('id') id: string,
    @Body() dto: ReconcileAccountDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.finance.reconcileAccount(id, dto, user);
  }

  // ── Presupuestos ─────────────────────────────────────────────────────────────
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('budgets')
  listBudgets(
    @CurrentUser() user: JwtUser,
    @Query('fiscalYear') fiscalYear?: string,
  ) {
    return this.finance.listBudgets(
      user,
      fiscalYear ? Number.parseInt(fiscalYear, 10) : undefined,
    );
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('budgets/:id')
  getBudget(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.finance.getBudget(id, user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('budgets')
  createBudget(@Body() dto: CreateBudgetDto, @CurrentUser() user: JwtUser) {
    return this.finance.createBudget(dto, user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Patch('budgets/:id')
  updateBudget(
    @Param('id') id: string,
    @Body() dto: UpdateBudgetDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.finance.updateBudget(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Delete('budgets/:id')
  deleteBudget(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.finance.deleteBudget(id, user);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('budgets/:id/vs-actual')
  budgetVsActual(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @Query('sedeId') sedeId?: string,
  ) {
    return this.finance.budgetVsActual(id, user, sedeId);
  }

  // ── Reportes ─────────────────────────────────────────────────────────────────
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('pl')
  profitAndLoss(
    @CurrentUser() user: JwtUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('sedeId') sedeId?: string,
  ) {
    return this.finance.profitAndLoss(user, from, to, sedeId);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('overview')
  overview(@CurrentUser() user: JwtUser, @Query('sedeId') sedeId?: string) {
    return this.finance.overview(user, sedeId);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('cashflow')
  cashflow(
    @CurrentUser() user: JwtUser,
    @Query('days') days?: string,
    @Query('sedeId') sedeId?: string,
    @Query('includeProjections') includeProjections?: string,
  ) {
    return this.finance.cashflowProjection(user, {
      days: days ? Number.parseInt(days, 10) : undefined,
      sedeId,
      includeProjections: includeProjections !== 'false',
    });
  }
}
