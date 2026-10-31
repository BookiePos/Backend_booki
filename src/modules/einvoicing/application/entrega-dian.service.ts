import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
    if (!opciones.forzar && doc.pdfPath && doc.attachedPath) {
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
