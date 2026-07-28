import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { LedgerService } from '../application/ledger.service';
import {
  CreateAccountDto,
  CreateJournalEntryDto,
} from '../application/dto/ledger.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('accounts')
  listAccounts() {
    return this.ledger.listAccounts();
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('accounts')
  createAccount(@Body() dto: CreateAccountDto) {
    return this.ledger.createAccount(dto);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('entries')
  listEntries(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sourceType') sourceType?: string,
    @Query('accountCode') accountCode?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ledger.listEntries({
      from,
      to,
      sourceType,
      accountCode,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('entries/:id')
  getEntry(@Param('id') id: string) {
    return this.ledger.getEntry(id);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('entries')
  postEntry(@Body() dto: CreateJournalEntryDto, @CurrentUser() user: JwtUser) {
    return this.ledger.postFromDto(dto, user.email);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('entries/:id/reverse')
  reverse(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.ledger.reverse(id, user.email);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('trial-balance')
  trialBalance(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sedeId') sedeId?: string,
  ) {
    return this.ledger.trialBalance({ from, to, sedeId });
  }
}
