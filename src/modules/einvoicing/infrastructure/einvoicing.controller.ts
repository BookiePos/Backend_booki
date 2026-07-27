import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { EinvoicingService } from '../application/einvoicing.service';
import { CreateInvoiceDto } from '../application/dto/create-invoice.dto';
import { CreditNoteDto } from '../application/dto/credit-note.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('einvoicing')
export class EinvoicingController {
  constructor(private readonly einvoicing: EinvoicingService) {}

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get()
  list(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.einvoicing.list(sedeId, user);
  }

  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.einvoicing.get(id, user);
  }

  /** Genera la factura electrónica de una venta. */
  @RequirePermissions(PERMISSIONS.POS_SELL)
  @Post('from-sale')
  fromSale(@Body() dto: CreateInvoiceDto, @CurrentUser() user: JwtUser) {
    return this.einvoicing.createFromSale(dto.saleId, user);
  }

  /** Genera la nota crédito que anula/corrige una factura. */
  @RequirePermissions(PERMISSIONS.POS_VOID_AUTHORIZE)
  @Post(':id/credit-note')
  creditNote(
    @Param('id') id: string,
    @Body() dto: CreditNoteDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.einvoicing.createCreditNote(id, dto.reason, user);
  }
}
