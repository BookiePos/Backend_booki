import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EinvoicingService } from '../application/einvoicing.service';
import { FiscalEmittersService } from '../application/fiscal-emitters.service';
import { TransmisionDianService } from '../application/transmision-dian.service';
import { NominaElectronicaService } from '../application/nomina-electronica.service';
import { NominaPeriodoService } from '../application/nomina-periodo.service';
import { HabilitacionNominaService } from '../application/habilitacion-nomina.service';
import { AjusteNominaDto } from '../application/dto/ajuste-nomina.dto';
import { EmitirPeriodoNominaDto } from '../application/dto/emitir-periodo-nomina.dto';
import { DocumentoFeVistaService } from '../application/documento-fe-vista.service';
import { RangosDianService } from '../application/rangos-dian.service';
import { EnviarCorreoDto } from '../application/dto/enviar-correo.dto';
import { EntregaDianService } from '../application/entrega-dian.service';
import {
  CERT_MAX_BYTES,
  CertificadoEmisorService,
  type ArchivoCertificado,
} from '../application/certificado-emisor.service';
import { ConfigurarFacturaDto } from '../application/dto/configurar-factura.dto';
import { ConfigurarNominaDto } from '../application/dto/configurar-nomina.dto';
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
    private readonly entrega: EntregaDianService,
    private readonly vista: DocumentoFeVistaService,
    private readonly rangosDian: RangosDianService,
    private readonly nomina: NominaElectronicaService,
    private readonly periodos: NominaPeriodoService,
    private readonly habilitacionNomina: HabilitacionNominaService,
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
  async registerResolution(
    @Param('sedeId') sedeId: string,
    @Body() dto: RegisterResolutionDto,
    @CurrentUser() user: JwtUser,
  ) {
    const { traerClaveDeDian, ...datos } = dto;
    if (traerClaveDeDian) {
      // Registrar desde un rango de la DIAN: la clave la lee el servidor.
      if (!user.permissions.includes(PERMISSIONS.EINVOICING_CONFIGURE)) {
        throw new ForbiddenException('Traer la clave técnica de la DIAN requiere permiso de configuración.');
      }
      const rango = await this.rangosDian.claveTecnicaDe(
        sedeId,
        { numero: datos.numero, prefijo: datos.prefijo?.toUpperCase(), desde: datos.rangoDesde, hasta: datos.rangoHasta },
        user,
      );
      if (!rango?.claveTecnica) {
        throw new BadRequestException('La DIAN no devolvió ese rango. Vuelve a traer los rangos.');
      }
      // Manda lo que dijo la DIAN, no lo del DTO: número, prefijo, tramo y fechas.
      datos.numero = rango.resolucion;
      datos.prefijo = rango.prefijo;
      datos.rangoDesde = rango.desde;
      datos.rangoHasta = rango.hasta;
      datos.fechaResolucion = rango.fechaResolucion;
      datos.vigenciaDesde = rango.vigenciaDesde;
      datos.vigenciaHasta = rango.vigenciaHasta;
      datos.claveTecnica = rango.claveTecnica;
    }
    return this.einvoicing.registerResolution(sedeId, datos, user);
  }

  /**
   * Rangos de numeración autorizados por la DIAN al emisor de la sede
   * (`GetNumberingRange`, con su certificado). Solo lectura: nada se registra
   * solo, y la clave técnica no viaja.
   */
  @RequirePermissions(PERMISSIONS.EINVOICING_CONFIGURE)
  @Get('sedes/:sedeId/rangos-dian')
  rangosDeLaDian(@Param('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    return this.rangosDian.traer(sedeId, user);
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

  /**
   * Guarda SoftwareID, PIN (cifrado) y TestSetId de la FACTURA electrónica del
   * emisor. Igual que la nómina: solo el Dueño (`einvoicing.certificate`) y 503
   * sin llave de cifrado.
   */
  @RequirePermissions(PERMISSIONS.EINVOICING_CERTIFICATE)
  @Put('sedes/:sedeId/emisor/factura')
  configurarFactura(
    @Param('sedeId') sedeId: string,
    @Body() dto: ConfigurarFacturaDto,
    @CurrentUser() user: JwtUser,
    @Ip() ip: string,
  ) {
    return this.emisores.configurarFactura(sedeId, dto, user, ip);
  }

  /**
   * Guarda SoftwareID, PIN (cifrado) y TestSetId de la nómina electrónica del
   * emisor. Solo el Dueño (`einvoicing.certificate`, como el .p12): el PIN es un
   * secreto. Sin llave de cifrado responde 503 y no escribe nada.
   */
  @RequirePermissions(PERMISSIONS.EINVOICING_CERTIFICATE)
  @Put('sedes/:sedeId/emisor/nomina')
  configurarNomina(
    @Param('sedeId') sedeId: string,
    @Body() dto: ConfigurarNominaDto,
    @CurrentUser() user: JwtUser,
    @Ip() ip: string,
  ) {
    return this.emisores.configurarNomina(sedeId, dto, user, ip);
  }

  /** Pre-vuelo del mes: por trabajador, qué bloquea o advierte. No emite nada. */
  @RequirePermissions(PERMISSIONS.PAYROLL_EINVOICE)
  @Post('nomina/periodos/:periodo/preparar')
  prepararNomina(@Param('periodo') periodo: string, @Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    return this.periodos.preparar(periodo, sedeId, user);
  }

  /** Emite los trabajadores sin bloqueo, en lotes con cursor (presupuesto de Vercel). Idempotente. */
  @RequirePermissions(PERMISSIONS.PAYROLL_EINVOICE)
  @Post('nomina/periodos/:periodo/emitir')
  emitirNominaPeriodo(
    @Param('periodo') periodo: string,
    @Query('sedeId') sedeId: string,
    @Body() dto: EmitirPeriodoNominaDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.periodos.emitir(periodo, sedeId, user, dto);
  }

  /** Documentos de nómina electrónica del mes (sin datos sensibles). */
  @RequirePermissions(PERMISSIONS.PAYROLL_EINVOICE)
  @Get('nomina')
  listarNomina(@Query('periodo') periodo: string, @Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    return this.periodos.listar(periodo, sedeId, user);
  }

  /** Nota de ajuste (103): reemplazar (recalcula desde las corridas) o eliminar. */
  @RequirePermissions(PERMISSIONS.PAYROLL_EINVOICE)
  @Post('nomina/:id/ajuste')
  ajustarNomina(@Param('id') id: string, @Body() dto: AjusteNominaDto, @CurrentUser() user: JwtUser) {
    return this.periodos.ajustar(id, dto.tipoNota, user);
  }

  /** Arma, firma y envía el set de pruebas de nómina (trabajador sintético). Solo ambiente 2. */
  @RequirePermissions(PERMISSIONS.EINVOICING_CERTIFICATE)
  @Post('sedes/:sedeId/emisor/nomina/habilitacion')
  iniciarHabilitacionNomina(@Param('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    return this.habilitacionNomina.iniciar(sedeId, user);
  }

  /** Reconsulta el veredicto del set de pruebas de nómina. */
  @RequirePermissions(PERMISSIONS.EINVOICING_CERTIFICATE)
  @Get('sedes/:sedeId/emisor/nomina/habilitacion')
  estadoHabilitacionNomina(@Param('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    return this.habilitacionNomina.consultar(sedeId, user);
  }

  /**
   * Transmite (o reintenta) un documento de nómina electrónica ya generado:
   * reenvía el mismo XML firmado. Credenciales de nómina; sin ellas, CONFIG_FALTANTE.
   */
  @RequirePermissions(PERMISSIONS.PAYROLL_EINVOICE)
  @Post('nomina/:id/transmitir')
  transmitirNomina(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.nomina.transmitir(id, user);
  }

  /** Estado de un documento de nómina electrónica (consulta a la DIAN si está en vuelo). */
  @RequirePermissions(PERMISSIONS.PAYROLL_EINVOICE)
  @Get('nomina/:id')
  consultarNomina(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.nomina.consultar(id, user);
  }

  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Get()
  list(@Query('sedeId') sedeId: string, @CurrentUser() user: JwtUser) {
    if (!sedeId) throw new BadRequestException('sedeId es obligatorio');
    return this.einvoicing.list(sedeId, user);
  }

  /** Detalle para la pantalla: estado, motivos legibles, descargas disponibles y correo. */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Get('documentos/:id/detalle')
  detalle(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.vista.detalle(id, user);
  }

  /** URLs firmadas de vida corta del XML firmado, el PDF y el ZIP (nunca se guardan). */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Get('documentos/:id/descargas')
  descargas(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.vista.descargas(id, user);
  }

  /** Envía el ZIP al adquiriente (o al correo indicado). Solo documentos aceptados; con tope de envíos. */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Post('documentos/:id/correo')
  enviarCorreo(@Param('id') id: string, @Body() dto: EnviarCorreoDto, @CurrentUser() user: JwtUser) {
    return this.vista.enviarCorreo(id, dto.email, user);
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

  /**
   * Regenera la entrega al adquiriente de un documento ACEPTADO: PDF y
   * AttachedDocument firmado + ZIP en el bucket privado (sin correo). Mismo
   * permiso que transmitir; el servicio comprueba el acceso a la sede, que
   * esté aceptado y lo deja en la auditoría. Idempotente: mismas rutas.
   */
  @RequirePermissions(PERMISSIONS.EINVOICING_ISSUE)
  @Post('documentos/:id/entrega')
  regenerarEntrega(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.entrega.regenerar(id, user);
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
