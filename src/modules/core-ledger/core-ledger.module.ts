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
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { LedgerService } from './application/ledger.service';
import { LedgerPostingService } from './application/ledger-posting.service';
import { LedgerController } from './infrastructure/ledger.controller';

@Module({
  imports: [
    CoreAuthModule,
    TenantMongooseModule.forFeature([
      { name: LedgerAccount.name, schema: LedgerAccountSchema },
      { name: JournalEntry.name, schema: JournalEntrySchema },
    ]),
  ],
  controllers: [LedgerController],
  providers: [LedgerService, LedgerPostingService],
  exports: [LedgerService, LedgerPostingService],
})
export class CoreLedgerModule {}
