import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
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
  FinanceReceivable,
  FinanceReceivableSchema,
} from './infrastructure/schemas/finance-receivable.schema';
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
  Product,
  ProductSchema,
} from '../inventory/infrastructure/schemas/product.schema';
import {
  PayrollRun,
  PayrollRunSchema,
} from '../payroll/infrastructure/schemas/payroll-run.schema';
import { Sede, SedeSchema } from '../sedes/infrastructure/schemas/sede.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { CajaModule } from '../caja/caja.module';
import { CoreLedgerModule } from '../core-ledger/core-ledger.module';
import { CustomersModule } from '../customers/customers.module';
import { FinanceService } from './application/finance.service';
import { FinanceController } from './infrastructure/finance.controller';

@Module({
  imports: [
    CoreAuthModule,
    CajaModule,
    CoreLedgerModule,
    CustomersModule,
    TenantMongooseModule.forFeature([
      { name: FinanceCategory.name, schema: FinanceCategorySchema },
      { name: FinanceExpense.name, schema: FinanceExpenseSchema },
      { name: FinancePayable.name, schema: FinancePayableSchema },
      { name: FinanceReceivable.name, schema: FinanceReceivableSchema },
      { name: FinanceAccount.name, schema: FinanceAccountSchema },
      { name: FinanceMovement.name, schema: FinanceMovementSchema },
      { name: FinanceBudget.name, schema: FinanceBudgetSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: Product.name, schema: ProductSchema },
      { name: PayrollRun.name, schema: PayrollRunSchema },
      { name: Sede.name, schema: SedeSchema },
    ]),
  ],
  controllers: [FinanceController],
  providers: [FinanceService],
})
export class FinanceModule {}
