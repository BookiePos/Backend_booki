import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ElectronicDocument,
  type ElectronicDocumentDocument,
} from '../infrastructure/schemas/electronic-document.schema';
import {
  applicationResponseDe,
  construirAttachedDocument,
  ErrorEntrega,
} from '../domain/entrega/attached-document';
import { normalizarNit } from '../domain/consecutivo-unico';
import {
  datosRepresentacionDe,
  generarRepresentacionGrafica,
} from '../infrastructure/entrega/representacion-grafica';
import { zipArchivos } from '../infrastructure/dian/zip-memoria';
import { consecutivoDeNumero, nombresEntrega } from '../infrastructure/dian/nombre-archivo';
import { ErrorFirma } from '../infrastructure/firma/material-p12';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { AuditService } from '../../core-audit/application/audit.service';
import { FIRMANTE_DIAN, FirmaNoDisponibleError, type FirmanteDian } from './transmision-dian.puertos';
import type { EntregaDian, OpcionesEntrega, ResultadoEntrega } from './entrega-dian.puerto';
import { MailService } from '../../core-auth/application/mail.service';
import { cop } from '../../finance/domain/money.util';

/** Una reserva de la entrega de contingencia (archivos o correo) que no terminó se puede retomar pasado esto. */
export const REINTENTO_ENTREGA_CONTINGENCIA_MS = 10 * 60_000;
/** Tope de intentos del correo de la 04. */
export const MAX_CORREOS_CONTINGENCIA = 3;

interface EstadoEntregaContingencia {
  reservadaAt?: Date;
  archivosAt?: Date;
  correoAt?: Date;
  correoIntentos?: number;
  /** true salió; 'ambiguo' pudo salir (no se repite); false falló (se reintenta). */
  correoEnviado?: boolean | 'ambiguo';
}

/** Correo con formato de correo (como el envío manual). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sin la ApplicationResponse de la DIAN no hay AttachedDocument (ver `applicationResponseDe`). */
export const MOTIVO_SIN_APPLICATION_RESPONSE = 'SIN_APPLICATION_RESPONSE';
export const MOTIVO_FIRMA_NO_DISPONIBLE = 'FIRMA_NO_DISPONIBLE';

/**
 * Entrega al adquiriente de un documento ACEPTADO (Fase 5B, sin correo):
 *
 *  1. lee el XML firmado que quedó en el bucket (`xmlPath`, validado contra la
 *     empresa del contexto y este documento);
 *  2. arma la representación gráfica (PDF) y la guarda → `pdfPath`;
 *  3. con la ApplicationResponse de la DIAN arma el AttachedDocument, lo firma
 *     con el MISMO emisor que firmó la factura (el de la ruta del XML) y guarda
 *     el ZIP (`ad….xml` + `ad….pdf`) → `attachedPath`.
 *
 * Nunca toca `dianStatus`: cada escritura exige que el documento siga
 * `accepted` y solo pone rutas y `entregaDian`. Idempotente: las rutas son fijas
 * por documento (el bucket hace upsert) y una entrega completa no se rehace sin
 * `forzar`. El correo al adquiriente queda para otro PR.
 */
@Injectable()
export class EntregaDianService implements EntregaDian {
  private readonly logger = new Logger(EntregaDianService.name);

  constructor(
    @InjectModel(ElectronicDocument.name)
    private readonly model: Model<ElectronicDocumentDocument>,
    private readonly storage: EinvoicingStorageService,
    @Inject(FIRMANTE_DIAN) private readonly firmante: FirmanteDian,
    private readonly audit: AuditService,
    /** Correo de la entrega de contingencia (Fase 9). Opcional: sin él solo se guardan los archivos. */
    @Optional() private readonly mail?: MailService,
  ) {}

  async entregar(
    doc: ElectronicDocumentDocument,
    opciones: OpcionesEntrega = {},
  ): Promise<ResultadoEntrega> {
    const documentoId = String(doc._id);
    const base = { documentoId, pdf: false, zip: false };
    if (doc.dianStatus !== 'accepted') return { ...base, estado: 'omitida', motivo: 'NO_ACEPTADO' };
    // Fase 5: solo la factura de venta. Notas y POS llegan con sus fases.
    if (doc.type !== 'invoice') return { ...base, estado: 'omitida', motivo: 'TIPO_NO_SOPORTADO' };
    // La entrega de contingencia (XML 04 sin ApplicationResponse) se rehace con
    // el AttachedDocument cuando la DIAN acepta: es OTRO artefacto.
    const deContingencia = (doc.entregaDian as { estado?: string } | undefined)?.estado === 'contingencia';
    if (!opciones.forzar && !deContingencia && doc.pdfPath && doc.attachedPath) {
      return { ...base, estado: 'ya_entregada', pdf: true, zip: true };
    }
    try {
      return await this.armarYGuardar(doc);
    } catch (err) {
      // Solo el nombre: el mensaje podría citar el XML o la ruta del bucket.
      const motivo = String((err as Error)?.name ?? 'Error').slice(0, 60);
      await this.marcar(documentoId, { entregaDian: { estado: 'fallida', motivo, at: new Date() } }).catch(
        () => undefined,
      );
      throw err;
    }
  }

  private async armarYGuardar(doc: ElectronicDocumentDocument): Promise<ResultadoEntrega> {
    const documentoId = String(doc._id);
    // (1) El XML que se transmitió. La ruta guardada se valida contra la empresa
    // del contexto y contra ESTE documento antes de tocar el bucket.
    const xmlFactura = (await this.storage.leerArtefactoGuardado(doc.xmlPath, documentoId, 'xml')).toString(
      'utf8',
    );
    // Ya validada: `einvoicing/<empresa>/<emisor>/docs/<docId>/documento.xml`.
    const emisorId = String(doc.xmlPath).split('/')[2]!;

    // (2) PDF.
    const pdf = await generarRepresentacionGrafica(datosRepresentacionDe(doc));
    const { pathname: pdfPath } = await this.storage.guardarArtefacto(emisorId, documentoId, 'pdf', pdf);

    // (3) AttachedDocument firmado + ZIP.
    const applicationResponse = applicationResponseDe(doc.respuestaDian);
    if (!applicationResponse) return this.incompleta(documentoId, pdfPath, MOTIVO_SIN_APPLICATION_RESPONSE);

    const emisor = doc.emisor ?? {};
    const adquiriente = doc.adquiriente ?? {};
    let attached: string;
    try {
      attached = construirAttachedDocument({
        fullNumber: doc.fullNumber,
        cufe: doc.cufe ?? '',
        issueDate: doc.issueDate,
        tipoAmbiente: doc.tipoAmbiente ?? '2',
        emisor: {
          nombre: emisor.name ?? '',
          nit: emisor.nitNorm ?? normalizarNit(emisor.nit) ?? '',
          dv: emisor.nitDv,
          tipoDocumento: '31',
        },
        adquiriente: {
          nombre: adquiriente.name ?? 'Consumidor final',
          nit: adquiriente.docNumber ?? '',
          dv: adquiriente.nitDv,
          tipoDocumento: adquiriente.docType,
        },
        xmlFactura,
        applicationResponse,
        validadoAt: this.fecha(doc.respuestaDian?.recibidaAt),
        ahora: new Date(),
      });
    } catch (err) {
      if (err instanceof ErrorEntrega) return this.incompleta(documentoId, pdfPath, err.codigo);
      throw err;
    }

    let firmado: string;
    try {
      firmado = await this.firmante.firmar(attached, emisorId);
    } catch (err) {
      if (err instanceof FirmaNoDisponibleError || err instanceof ErrorFirma) {
        return this.incompleta(documentoId, pdfPath, MOTIVO_FIRMA_NO_DISPONIBLE);
      }
      throw err;
    }

    const nombres = nombresEntrega({
      nit: emisor.nitNorm ?? normalizarNit(emisor.nit) ?? '',
      consecutivo: consecutivoDeNumero(doc.fullNumber),
      anio: Number(String(doc.issueDate).slice(0, 4)),
    });
    const zip = zipArchivos([
      { nombre: nombres.xml, contenido: firmado },
      { nombre: nombres.pdf, contenido: pdf },
    ]);
    const { pathname: attachedPath } = await this.storage.guardarArtefacto(emisorId, documentoId, 'zip', zip);
    await this.marcar(documentoId, {
      pdfPath,
      attachedPath,
      entregaDian: { estado: 'completa', archivo: nombres.zip, at: new Date() },
    });
    return { documentoId, estado: 'completa', pdf: true, zip: true };
  }

  /**
   * Entrega de la FACTURA 04 al declarar la contingencia de la DIAN (Fase 9;
   * art. 37 Res. 165/2023 y anexo FEV §12.2: se expide y entrega sin validación
   * previa). PDF y ZIP con el XML 04 firmado + PDF, SIN ApplicationResponse (no
   * existe todavía) y, si el adquiriente tiene correo, un envío.
   *
   * Idempotente y una sola vez: la reserva es una escritura atómica sobre
   * `entregaContingencia` (si ya existe, no hace nada); si el armado falla, la
   * reserva se libera y el cron/endpoint la puede reintentar; el correo no se
   * repite. Cuando la DIAN acepta, `entregar` rehace el ZIP con el
   * AttachedDocument (otro artefacto) como siempre.
   */
  async entregarContingencia(doc: ElectronicDocumentDocument): Promise<ResultadoEntrega> {
    const documentoId = String(doc._id);
    const base = { documentoId, pdf: false, zip: false };
    if (doc.type !== 'invoice' || doc.contingencia?.tipo !== '04') {
      return { ...base, estado: 'omitida', motivo: 'NO_ES_04' };
    }
    if (doc.dianStatus !== 'contingency') return { ...base, estado: 'omitida', motivo: 'NO_EN_CONTINGENCIA' };
    const ec = doc.entregaContingencia as EstadoEntregaContingencia | undefined;
    const ahora = new Date();
    // Archivos ya hechos: solo queda, si falló, el correo (con su propia reserva).
    if (ec?.archivosAt) {
      await this.reintentarCorreo(doc, ec, ahora);
      return { ...base, estado: 'ya_entregada', pdf: true, zip: true };
    }
    // Una reserva sin archivos de hace más de 10 min quedó a medias: se retoma.
    // La escritura exige la MISMA reserva vista, así que solo uno la retoma.
    const reservadaAt = ec?.reservadaAt ? new Date(ec.reservadaAt) : undefined;
    if (reservadaAt && ahora.getTime() - reservadaAt.getTime() < REINTENTO_ENTREGA_CONTINGENCIA_MS) {
      return { ...base, estado: 'ya_entregada' };
    }
    const reserva = await this.model
      .updateOne(
        reservadaAt
          ? {
              _id: doc._id,
              dianStatus: 'contingency',
              'entregaContingencia.reservadaAt': ec!.reservadaAt,
              'entregaContingencia.archivosAt': { $exists: false },
            }
          : { _id: doc._id, dianStatus: 'contingency', entregaContingencia: { $exists: false } },
        reservadaAt
          ? { $set: { 'entregaContingencia.reservadaAt': ahora } }
          : { $set: { entregaContingencia: { reservadaAt: ahora } } },
      )
      .exec();
    if (reserva.matchedCount !== 1) return { ...base, estado: 'ya_entregada', pdf: true, zip: true };

    let zip: Buffer;
    let pdfPath: string;
    let attachedPath: string;
    let archivo: string;
    try {
      const xml04 = (await this.storage.leerArtefactoGuardado(doc.xmlPath, documentoId, 'xml')).toString('utf8');
      const emisorId = String(doc.xmlPath).split('/')[2]!;
      const pdf = await generarRepresentacionGrafica(datosRepresentacionDe(doc));
      pdfPath = (await this.storage.guardarArtefacto(emisorId, documentoId, 'pdf', pdf)).pathname;
      const emisor = doc.emisor ?? {};
      const nombres = nombresEntrega({
        nit: emisor.nitNorm ?? normalizarNit(emisor.nit) ?? '',
        consecutivo: consecutivoDeNumero(doc.fullNumber),
        anio: Number(String(doc.issueDate).slice(0, 4)),
      });
      // El XML que se entrega es la factura 04 firmada tal cual (no un AttachedDocument).
      zip = zipArchivos([
        { nombre: nombres.xml, contenido: xml04 },
        { nombre: nombres.pdf, contenido: pdf },
      ]);
      attachedPath = (await this.storage.guardarArtefacto(emisorId, documentoId, 'zip', zip)).pathname;
      archivo = nombres.zip;
    } catch (err) {
      // Sin archivos no hay entrega: la reserva vence en 10 min y la cola de
      // contingencia la retoma (`reservadaAt` sin `archivosAt`).
      this.logger.warn(`Documento ${documentoId}: la entrega de la 04 quedó a medias; se retoma en 10 min.`);
      throw err;
    }
    await this.model
      .updateOne(
        { _id: doc._id, dianStatus: 'contingency' },
        {
          $set: {
            pdfPath,
            attachedPath,
            entregaDian: { estado: 'contingencia', archivo, at: new Date() },
            'entregaContingencia.archivosAt': new Date(),
          },
        },
      )
      .exec();
    await this.correoContingencia(doc, ec, ahora, zip);
    return { documentoId, estado: 'contingencia', pdf: true, zip: true };
  }

  /** El correo de la 04 falló (no «ambiguo»): se reintenta con el ZIP ya guardado. */
  private async reintentarCorreo(doc: ElectronicDocumentDocument, ec: EstadoEntregaContingencia, ahora: Date): Promise<void> {
    if (ec.correoEnviado === true || ec.correoEnviado === 'ambiguo') return;
    if (ec.correoAt && ahora.getTime() - new Date(ec.correoAt).getTime() < REINTENTO_ENTREGA_CONTINGENCIA_MS) return;
    if (!doc.attachedPath) return;
    try {
      const zip = await this.storage.leerArtefactoGuardado(doc.attachedPath, String(doc._id), 'zip');
      await this.correoContingencia(doc, ec, ahora, zip);
    } catch (err) {
      this.logger.warn(`Documento ${String(doc._id)}: no se pudo reintentar el correo de la 04 (${(err as Error)?.name ?? 'Error'}).`);
    }
  }

  /**
   * Un correo de la 04 (si hay a quién). Reserva atómica propia (`correoAt`,
   * condicionada a la vista): dos procesos a la vez mandan uno. Solo un fallo
   * claro se reintenta (hasta `MAX_CORREOS_CONTINGENCIA`); uno «ambiguo» (pudo
   * salir) no se repite.
   */
  private async correoContingencia(
    doc: ElectronicDocumentDocument,
    ec: EstadoEntregaContingencia | undefined,
    ahora: Date,
    zip: Buffer,
  ): Promise<void> {
    const para = (doc.adquiriente?.email ?? '').trim().toLowerCase();
    if (!this.mail || !para || para.length > 254 || !EMAIL.test(para)) return;
    if ((ec?.correoIntentos ?? 0) >= MAX_CORREOS_CONTINGENCIA) return;
    const documentoId = String(doc._id);
    const r = await this.model
      .updateOne(
        {
          _id: doc._id,
          'entregaContingencia.correoEnviado': { $nin: [true, 'ambiguo'] },
          'entregaContingencia.correoAt': ec?.correoAt ? ec.correoAt : { $exists: false },
        },
        { $set: { 'entregaContingencia.correoAt': ahora }, $inc: { 'entregaContingencia.correoIntentos': 1 } },
      )
      .exec();
    if (r.matchedCount !== 1) return;
    try {
      const res = await this.mail.sendFacturaElectronica({
        to: para,
        numero: doc.fullNumber,
        emisorNombre: doc.emisor?.name ?? 'Tu proveedor',
        total: `$ ${cop(Number(doc.total) || 0).toLocaleString('es-CO')}`,
        zip,
        filename: `${doc.fullNumber}.zip`,
      });
      const enviado = res.sent === true ? true : (res as { ambiguo?: boolean }).ambiguo ? 'ambiguo' : false;
      await this.model.updateOne({ _id: doc._id }, { $set: { 'entregaContingencia.correoEnviado': enviado } }).exec();
    } catch (err) {
      await this.model
        .updateOne({ _id: doc._id }, { $set: { 'entregaContingencia.correoEnviado': false } })
        .exec()
        .catch(() => undefined);
      this.logger.warn(`Documento ${documentoId}: el correo de la contingencia 04 falló (${(err as Error)?.name ?? 'Error'}); se reintenta.`);
    }
  }

  /**
   * Camino HTTP para regenerar la entrega de un documento aceptado (p. ej. tras
   * un fallo o cuando llegue la ApplicationResponse). Acceso a la sede del
   * documento y auditoría, como la transmisión.
   */
  async regenerar(docId: string, user: JwtUser): Promise<ResultadoEntrega> {
    TenantContext.currentOrThrow();
    const documentoId = String(docId).slice(0, 64);
    try {
      const doc = Types.ObjectId.isValid(docId) ? await this.model.findById(docId).exec() : null;
      if (!doc) throw new NotFoundException('Documento electrónico no encontrado');
      assertSedeAccess(user, doc.sedeId.toString());
      if (doc.dianStatus !== 'accepted') {
        throw new BadRequestException('Solo un documento aceptado por la DIAN tiene entrega al adquiriente.');
      }
      if (doc.type !== 'invoice') {
        throw new BadRequestException('Por ahora solo la factura de venta tiene entrega al adquiriente.');
      }
      const r = await this.entregar(doc, { forzar: true });
      await this.auditar(documentoId, user, true, r.motivo ?? r.estado);
      return r;
    } catch (err) {
      await this.auditar(documentoId, user, false, (err as Error)?.name ?? 'Error');
      throw err;
    }
  }

  private async incompleta(documentoId: string, pdfPath: string, motivo: string): Promise<ResultadoEntrega> {
    await this.marcar(documentoId, { pdfPath, entregaDian: { estado: 'incompleta', motivo, at: new Date() } });
    this.logger.warn(`Documento ${documentoId}: entrega solo con PDF (${motivo}).`);
    return { documentoId, estado: 'incompleta', motivo, pdf: true, zip: false };
  }

  /** Solo rutas y `entregaDian`, y solo si el documento sigue aceptado. */
  private async marcar(documentoId: string, set: Record<string, unknown>): Promise<void> {
    await this.model.updateOne({ _id: documentoId, dianStatus: 'accepted' }, { $set: set }).exec();
  }

  private fecha(v: unknown): Date | undefined {
    if (typeof v !== 'string' && !(v instanceof Date)) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  private async auditar(documentoId: string, user: JwtUser, success: boolean, codigo: string): Promise<void> {
    await this.audit.record({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      method: 'POST',
      path: `/einvoicing/documentos/${documentoId}/entrega`,
      success,
      action: 'einvoicing.documento.entrega',
      detail: { documentoId, codigo: String(codigo).slice(0, 60) },
    });
  }
}
