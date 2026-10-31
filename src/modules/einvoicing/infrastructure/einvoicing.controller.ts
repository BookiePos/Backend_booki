import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EinvoicingService } from '../application/einvoicing.service';
import { FiscalEmittersService } from '../application/fiscal-emitters.service';
import { TransmisionDianService } from '../application/transmision-dian.service';
import {
  CERT_MAX_BYTES,
  CertificadoEmisorService,
  type ArchivoCertificado,
} from '../application/certificado-emisor.service';
import { CargarCertificadoDto } from '../application/dto/cargar-certificado.dto';
import { LlaveCifradoInterceptor } from './llave-cifrado.interceptor';
import { CreateInvoiceDto } from '../application/dto/create-invoice.dto';
import { CreditNoteDto } from '../application/dto/credit-note.dto';
import { RegisterResolutionDto } from '../application/dto/register-resolution.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('einvoicing')
export class EinvoicingController {
  constructor(
    private readonly einvoicing: EinvoicingService,
    private readonly emisores: FiscalEmittersService,
    private readonly certificados: CertificadoEmisorService,
    private readonly transmision: TransmisionDianService,
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

  /**
   * Emisor fiscal de la sede y qué le falta para emitir. Solo lectura: nunca
   * devuelve secretos, a lo sumo si están configurados.
   */
  @RequirePermissions(PERMISSIONS.EINVOICING_CONFIGURE)
  @Get('sedes/:sedeId/emisor')
  emisorDeSede(@Param('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    return this.emisores.vistaDeSede(sedeId, user);
  }

  /**
   * Sube o reemplaza el certificado .p12/.pfx del emisor de la sede (multipart:
   * `file` y `password`). Solo el Dueño (`einvoicing.certificate`). Sin llave
   * de cifrado responde 503 antes de leer el archivo; el tope de multer corta
   * la subida mientras llega.
   */
  @RequirePermissions(PERMISSIONS.EINVOICING_CERTIFICATE)
  @Post('sedes/:sedeId/emisor/certificado')
  @UseInterceptors(
    LlaveCifradoInterceptor,
    FileInterceptor('file', {
      // Un archivo y un campo de texto (`password`): nada más pasa de multer.
      limits: { fileSize: CERT_MAX_BYTES, files: 1, fields: 2, fieldSize: 1024, parts: 3 },
    }),
  )
  cargarCertificado(
    @Param('sedeId') sedeId: string,
    @UploadedFile() file: ArchivoCertificado | undefined,
    @Body() dto: CargarCertificadoDto,
    @CurrentUser() user: JwtUser,
    @Ip() ip: string,
  ) {
    return this.certificados.cargar(sedeId, file, dto.password, user, ip);
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

  /**
   * Transmite (o reintenta) el documento a la DIAN. Mismo permiso que la
   * emisión: transmitir es la segunda mitad de emitir. El servicio comprueba el
   * acceso a la sede del documento, el gate de ambiente y el bloqueo.
   */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Post('documentos/:id/transmitir')
  transmitir(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.transmision.transmitir(id, user);
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
