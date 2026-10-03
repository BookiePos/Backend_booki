import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { EinvoicingService } from '../application/einvoicing.service';
import { EinvoicingAccountsService } from '../application/einvoicing-accounts.service';
import { CreateInvoiceDto } from '../application/dto/create-invoice.dto';
import { CreditNoteDto } from '../application/dto/credit-note.dto';
import { RegisterResolutionDto } from '../application/dto/register-resolution.dto';
import {
  ConfigureSoftwareDto,
  RegisterCompanyDto,
  SetEnvironmentDto,
  UploadCertificateDto,
} from '../application/dto/connection.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** El NIT en la URL: solo dígitos, sin DV. */
function nitParam(raw: string): string {
  if (!/^\d{5,15}$/.test(raw)) {
    throw new BadRequestException('NIT inválido: solo dígitos, sin DV.');
  }
  return raw;
}

@Controller('einvoicing')
export class EinvoicingController {
  constructor(
    private readonly einvoicing: EinvoicingService,
    private readonly accounts: EinvoicingAccountsService,
  ) {}

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

  // ── Conexión con la DIAN (habilitación) ─────────────────────────────────────
  // Declaradas antes de `:id` para que "connection" no se tome por un id.

  /** Conexión de cada NIT del usuario y en qué paso va su habilitación. */
  @RequirePermissions(PERMISSIONS.EINVOICING_CONFIGURE)
  @Get('connection')
  connections(@CurrentUser() user: JwtUser) {
    return this.accounts.list(user);
  }

  /** Paso 1: crea la empresa en el facturador con los datos de la sede. */
  @RequirePermissions(PERMISSIONS.EINVOICING_CONFIGURE)
  @Post('connection/company')
  registerCompany(@Body() dto: RegisterCompanyDto, @CurrentUser() user: JwtUser) {
    return this.accounts.registerCompany(dto.sedeId, user);
  }

  /** Paso 2: certificado digital. Pasa al facturador; BookiPos no lo guarda. */
  @RequirePermissions(PERMISSIONS.EINVOICING_CONFIGURE)
  @Put('connection/:nit/certificate')
  uploadCertificate(
    @Param('nit') nit: string,
    @Body() dto: UploadCertificateDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.accounts.uploadCertificate(
      nitParam(nit),
      dto.certificate,
      dto.password,
      user,
    );
  }

  /** Paso 3: software propio de la DIAN (ID, PIN y set de pruebas). */
  @RequirePermissions(PERMISSIONS.EINVOICING_CONFIGURE)
  @Put('connection/:nit/software')
  configureSoftware(
    @Param('nit') nit: string,
    @Body() dto: ConfigureSoftwareDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.accounts.configureSoftware(nitParam(nit), dto, user);
  }

  /** Registra en el facturador la resolución de la sede y la de notas crédito. */
  @RequirePermissions(PERMISSIONS.EINVOICING_CONFIGURE)
  @Post('connection/resolutions/:sedeId')
  syncResolutions(@Param('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    return this.accounts.syncResolutions(sedeId, user);
  }

  /** Rangos que la DIAN asoció al software, con su clave técnica. */
  @RequirePermissions(PERMISSIONS.EINVOICING_CONFIGURE)
  @Get('connection/:nit/numbering-ranges')
  numberingRanges(@Param('nit') nit: string, @CurrentUser() user: JwtUser) {
    return this.accounts.numberingRanges(nitParam(nit), user);
  }

  /** Cambia el ambiente (habilitación ↔ producción). */
  @RequirePermissions(PERMISSIONS.EINVOICING_CONFIGURE)
  @Put('connection/:nit/environment')
  setEnvironment(
    @Param('nit') nit: string,
    @Body() dto: SetEnvironmentDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.accounts.setEnvironment(nitParam(nit), dto.environment, user);
  }

  // ── Documentos ──────────────────────────────────────────────────────────────

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

  /** PDF o XML del documento aceptado, tal como lo dejó el facturador. */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Get(':id/file/:kind')
  async file(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @CurrentUser() user: JwtUser,
  ): Promise<StreamableFile> {
    if (kind !== 'pdf' && kind !== 'xml') {
      throw new BadRequestException('El archivo es pdf o xml.');
    }
    const f = await this.einvoicing.downloadFile(id, kind, user);
    return new StreamableFile(f.data, {
      type: f.contentType,
      disposition: `inline; filename="${f.fileName.replace(/"/g, '')}"`,
    });
  }

  /** Genera la factura electrónica de una venta y la envía a la DIAN. */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Post('from-sale')
  fromSale(@Body() dto: CreateInvoiceDto, @CurrentUser() user: JwtUser) {
    return this.einvoicing.createFromSale(dto.saleId, user);
  }

  /** Reenvía un documento pendiente, rechazado o fallido, con su mismo número. */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Post(':id/retry')
  retry(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.einvoicing.retry(id, user);
  }

  /** Genera la nota crédito que anula una factura aceptada. */
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
