import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  LedgerAccount,
  LedgerAccountSchema,
} from './infrastructure/schemas/ledger-account.schema';
import {
  JournalEntry,
  JournalEntrySchema,
} from './infrastructure/schemas/journal-entry.schema';
import {
  LedgerPendiente,
  LedgerPendienteSchema,
} from './infrastructure/schemas/ledger-pendiente.schema';
import {
  Counter,
  CounterSchema,
} from '../sales/infrastructure/schemas/counter.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { LedgerService } from './application/ledger.service';
import { LedgerPostingService } from './application/ledger-posting.service';
import { LedgerConciliacionService } from './application/ledger-conciliacion.service';
import { LedgerController } from './infrastructure/ledger.controller';

@Module({
  imports: [
    CoreAuthModule,
    TenantMongooseModule.forFeature([
      { name: LedgerAccount.name, schema: LedgerAccountSchema },
      { name: JournalEntry.name, schema: JournalEntrySchema },
      { name: LedgerPendiente.name, schema: LedgerPendienteSchema },
      { name: Counter.name, schema: CounterSchema },
    ]),
  ],
  controllers: [LedgerController],
  providers: [LedgerService, LedgerPostingService, LedgerConciliacionService],
  exports: [LedgerService, LedgerPostingService, LedgerConciliacionService],
})
export class CoreLedgerModule {}
