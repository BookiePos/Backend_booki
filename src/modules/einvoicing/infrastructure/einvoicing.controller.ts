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
import { RegisterResolutionDto } from '../application/dto/register-resolution.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('einvoicing')
export class EinvoicingController {
  constructor(private readonly einvoicing: EinvoicingService) {}

  /**
   * Estado de la resolución de numeración de cada sede: cuánto queda de rango,
   * cuánta vigencia y si se puede emitir. Es lo que alimenta /panel/resoluciones.
   */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Get('resolutions')
  resolutions(@CurrentUser() user: JwtUser) {
    return this.einvoicing.resolutionStatus(user);
  }

  /** Registra o renueva la resolución de una sede, anclando el consecutivo. */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Post('resolutions/:sedeId')
  registerResolution(
    @Param('sedeId') sedeId: string,
    @Body() dto: RegisterResolutionDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.einvoicing.registerResolution(sedeId, dto, user);
  }

  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Get()
  list(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.einvoicing.list(sedeId, user);
  }

  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.einvoicing.get(id, user);
  }

  /** Genera la factura electrónica de una venta. */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Post('from-sale')
  fromSale(@Body() dto: CreateInvoiceDto, @CurrentUser() user: JwtUser) {
    return this.einvoicing.createFromSale(dto.saleId, user);
  }

  /** Genera la nota crédito que anula/corrige una factura. */
  @RequirePermissions(PERMISSIONS.EINVOICING_VOID)
  @Post(':id/credit-note')
  creditNote(
    @Param('id') id: string,
    @Body() dto: CreditNoteDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.einvoicing.createCreditNote(id, dto.reason, user);
  }
}
