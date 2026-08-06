import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../../shared/tenancy/tenant-mongoose.module';
import {
  FinanceAccount,
  FinanceAccountSchema,
} from '../infrastructure/schemas/finance-account.schema';
import {
  FinanceMovement,
  FinanceMovementSchema,
} from '../infrastructure/schemas/finance-movement.schema';
import { TreasuryPostingService } from './treasury-posting.service';

/**
 * Módulo liviano que expone `TreasuryPostingService` (auto-posteo a cuentas de
 * tesorería). Lo importan Finance (gastos/CxP/CxC) y Sales (ventas no-efectivo)
 * sin acoplar módulos pesados ni crear ciclos.
 */
@Module({
  imports: [
    TenantMongooseModule.forFeature([
      { name: FinanceAccount.name, schema: FinanceAccountSchema },
      { name: FinanceMovement.name, schema: FinanceMovementSchema },
    ]),
  ],
  providers: [TreasuryPostingService],
  exports: [TreasuryPostingService],
})
export class TreasuryModule {}
