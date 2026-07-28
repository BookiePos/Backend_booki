import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  FinanceCategory,
  FinanceCategorySchema,
} from './infrastructure/schemas/finance-category.schema';
import {
  FinanceExpense,
  FinanceExpenseSchema,
} from './infrastructure/schemas/finance-expense.schema';
import {
  FinancePayable,
  FinancePayableSchema,
} from './infrastructure/schemas/finance-payable.schema';
import {
  FinanceAccount,
  FinanceAccountSchema,
} from './infrastructure/schemas/finance-account.schema';
import {
  FinanceMovement,
  FinanceMovementSchema,
} from './infrastructure/schemas/finance-movement.schema';
import {
  FinanceBudget,
  FinanceBudgetSchema,
} from './infrastructure/schemas/finance-budget.schema';
import { Sale, SaleSchema } from '../sales/infrastructure/schemas/sale.schema';
import {
  PayrollRun,
  PayrollRunSchema,
} from '../payroll/infrastructure/schemas/payroll-run.schema';
import { Sede, SedeSchema } from '../sedes/infrastructure/schemas/sede.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CajaModule } from '../caja/caja.module';
import { FinanceService } from './application/finance.service';
import { FinanceController } from './infrastructure/finance.controller';

@Module({
  imports: [
    CoreAuthModule,
    CajaModule,
    MongooseModule.forFeature([
      { name: FinanceCategory.name, schema: FinanceCategorySchema },
      { name: FinanceExpense.name, schema: FinanceExpenseSchema },
      { name: FinancePayable.name, schema: FinancePayableSchema },
      { name: FinanceAccount.name, schema: FinanceAccountSchema },
      { name: FinanceMovement.name, schema: FinanceMovementSchema },
      { name: FinanceBudget.name, schema: FinanceBudgetSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: PayrollRun.name, schema: PayrollRunSchema },
      { name: Sede.name, schema: SedeSchema },
    ]),
  ],
  controllers: [FinanceController],
  providers: [FinanceService],
})
export class FinanceModule {}
