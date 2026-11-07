import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ElectronicDocument,
  type ElectronicDocumentDocument,
} from '../infrastructure/schemas/electronic-document.schema';
import { motivosLegibles, resumenEstado, type MotivoLegible } from '../domain/motivos-rechazo';
import { EinvoicingStorageService, type TipoArtefactoFe } from '../../../shared/storage/einvoicing-storage.service';
import { MailService, enmascararCorreo } from '../../core-auth/application/mail.service';
import { AuditService } from '../../core-audit/application/audit.service';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { cop } from '../../finance/domain/money.util';
import { EntregaDianService } from './entrega-dian.service';

/** Tope de envíos por correo de un mismo documento (incluye reenvíos). */
export const CORREO_MAX_ENVIOS = 5;
/** Espera mínima entre dos envíos del mismo documento (doble clic, reintentos ansiosos). */
export const CORREO_ESPERA_MS = 60_000;
/** Vida de la URL firmada de una descarga: se pide al hacer clic. */
export const DESCARGA_SEGUNDOS = 120;

/** Estados desde los que «Reintentar envío» tiene sentido. */
const ESTADOS_REINTENTABLES = ['draft', 'signed', 'sent', 'rejected'];
const EMAIL = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,255}\.[A-Za-z]{2,}$/;

/**
 * Contingencia del documento tal como la ve la pantalla: los mismos campos que
 * devuelve `GET /einvoicing/:id`, sin la ruta del XML original en el bucket
 * (`xmlOriginalPath`), que nunca sale de la API.
 */
export interface ContingenciaDocumentoFe {
  tipo: string;
  declaradaAt: Date;
  superadaAt?: Date;
  restablecidoAt?: Date;
  referencia?: { id: string; fecha: string };
  intentos?: number;
  cerradaAt?: Date;
  enviosXml?: number;
  enviosXmlConRespuesta?: number;
  noAplico?: boolean;
  motivoNoAplico?: string;
}

export interface DetalleDocumentoFe {
  id: string;
  tipo: string;
  sedeId: string;
  numero: string;
  fecha: string;
  dianStatus: string;
  estadoResumen: string;
  cufe?: string;
  qrUrl?: string;
  ambiente?: string;
  total: number;
  emisor: { nombre?: string; nit?: string };
  adquiriente: { nombre?: string; documento?: string; email?: string };
  resolucion?: { numero?: string; prefijo?: string };
  referencia?: { numero?: string };
  motivos: MotivoLegible[];
  codigoDian?: string;
  intentos: number;
  enviadoAt?: Date;
  puedeReintentar: boolean;
  entrega?: { estado?: string; motivo?: string; archivo?: string };
  descargas: { xml: boolean; pdf: boolean; zip: boolean };
  correo: { envios: number; restantes: number; ultimoAt?: Date; puedeEnviar: boolean };
}

export interface DescargasDocumentoFe {
  /** Segundos que vive cada URL. */
  venceEn: number;
  xml?: string;
  pdf?: string;
  zip?: string;
}

export interface ResultadoCorreoFe {
  enviado: true;
  para: string;
  envios: number;
  restantes: number;
}

/**
 * Detalle del documento electrónico para la pantalla: estado, motivos legibles,
 * descargas con URL firmada de vida corta y envío por correo al adquiriente.
 *
 * - Todo pasa por `assertSedeAccess` sobre la sede del documento.
 * - Las URLs firmadas se generan al pedirlas y NUNCA se guardan (ni en el
 *   documento ni en la auditoría); las rutas del bucket tampoco salen.
 * - El correo solo sale de un documento ACEPTADO, con tope de envíos y espera
 *   mínima reservados de forma atómica antes de enviar.
 */
@Injectable()
export class DocumentoFeVistaService {
  private readonly logger = new Logger(DocumentoFeVistaService.name);

  constructor(
    @InjectModel(ElectronicDocument.name)
    private readonly model: Model<ElectronicDocumentDocument>,
    private readonly storage: EinvoicingStorageService,
    private readonly mail: MailService,
    private readonly entrega: EntregaDianService,
    private readonly audit: AuditService,
  ) {}

  async detalle(id: string, user: JwtUser): Promise<DetalleDocumentoFe> {
    const doc = await this.cargar(id, user);
    const envios = this.enviosDe(doc);
    const ultimoAt = this.fecha(doc.correoEntrega?.ultimoAt);
    const aceptado = doc.dianStatus === 'accepted';
    const entrega = doc.entregaDian as { estado?: string; motivo?: string; archivo?: string } | undefined;
    return {
      id: String(doc._id),
      tipo: doc.type,
      sedeId: doc.sedeId.toString(),
      numero: doc.fullNumber,
      fecha: doc.issueDate,
      dianStatus: doc.dianStatus,
      estadoResumen: resumenEstado(doc.dianStatus),
      cufe: doc.cufe,
      qrUrl: doc.qrUrl,
      ambiente: doc.tipoAmbiente,
      total: doc.total,
      emisor: { nombre: doc.emisor?.name, nit: doc.emisor?.nit },
      adquiriente: {
        nombre: doc.adquiriente?.name,
        documento: doc.adquiriente?.docNumber,
        email: doc.adquiriente?.email,
      },
      resolucion: doc.resolution ? { numero: doc.resolution.numero, prefijo: doc.resolution.prefijo } : undefined,
      referencia: doc.referenceNumber ? { numero: doc.referenceNumber } : undefined,
      motivos: motivosLegibles(doc),
      codigoDian: typeof doc.respuestaDian?.codigo === 'string' ? doc.respuestaDian.codigo : undefined,
      intentos: doc.intentos ?? 0,
      enviadoAt: doc.enviadoAt,
      puedeReintentar: ESTADOS_REINTENTABLES.includes(doc.dianStatus),
      entrega: entrega ? { estado: entrega.estado, motivo: entrega.motivo, archivo: entrega.archivo } : undefined,
      descargas: { xml: Boolean(doc.xmlPath), pdf: Boolean(doc.pdfPath), zip: Boolean(doc.attachedPath) },
      contingencia: this.contingenciaVista(doc.contingencia),
      correo: {
        envios,
        restantes: Math.max(0, CORREO_MAX_ENVIOS - envios),
        ultimoAt,
        puedeEnviar: aceptado && doc.type === 'invoice' && envios < CORREO_MAX_ENVIOS,
      },
    };
  }

  /** La contingencia del documento sin datos internos (ruta del XML original). */
  private contingenciaVista(c: ElectronicDocumentDocument['contingencia']): ContingenciaDocumentoFe | undefined {
    if (!c?.tipo) return undefined;
    return {
      tipo: c.tipo,
      declaradaAt: c.declaradaAt,
      superadaAt: c.superadaAt,
      restablecidoAt: c.restablecidoAt,
      referencia: c.referencia,
      intentos: c.intentos,
      cerradaAt: c.cerradaAt,
      enviosXml: c.enviosXml,
      enviosXmlConRespuesta: c.enviosXmlConRespuesta,
      noAplico: c.noAplico,
      motivoNoAplico: c.motivoNoAplico,
    };
  }

  /** URLs firmadas (XML firmado, PDF y ZIP) de lo que el documento ya tiene. */
  async descargas(id: string, user: JwtUser): Promise<DescargasDocumentoFe> {
    const documentoId = String(id).slice(0, 64);
    try {
      const doc = await this.cargar(id, user);
      const salida: DescargasDocumentoFe = { venceEn: DESCARGA_SEGUNDOS };
      const rutas: [TipoArtefactoFe, string | undefined][] = [
        ['xml', doc.xmlPath],
        ['pdf', doc.pdfPath],
        ['zip', doc.attachedPath],
      ];
      for (const [tipo, ruta] of rutas) {
        if (!ruta) continue;
        // La ruta guardada se valida (empresa, documento, tipo) antes de firmar.
        const emisorId = this.storage.emisorDeRutaGuardada(ruta, documentoId, tipo);
        salida[tipo] = await this.storage.urlFirmadaArtefacto(emisorId, documentoId, tipo, DESCARGA_SEGUNDOS);
      }
      await this.auditar(documentoId, user, 'GET', 'descargas', true, 'ok');
      return salida;
    } catch (err) {
      await this.auditar(documentoId, user, 'GET', 'descargas', false, (err as Error)?.name ?? 'Error');
      throw err;
    }
  }

  /** Envía el ZIP del documento aceptado al adquiriente (o al correo indicado). */
  async enviarCorreo(id: string, email: string | undefined, user: JwtUser): Promise<ResultadoCorreoFe> {
    const documentoId = String(id).slice(0, 64);
    let destino = 'sin-destino';
    try {
      let doc = await this.cargar(id, user);
      if (doc.dianStatus !== 'accepted') {
        throw new BadRequestException('Solo un documento aceptado por la DIAN se envía por correo.');
      }
      if (doc.type !== 'invoice') {
        throw new BadRequestException('Por ahora solo la factura de venta se envía por correo.');
      }
      const delAdquiriente = (doc.adquiriente?.email ?? '').trim().toLowerCase();
      const indicado = (email ?? '').trim().toLowerCase();
      const personalizado = Boolean(indicado) && indicado !== delAdquiriente;
      const para = indicado || delAdquiriente;
      if (!para) {
        throw new BadRequestException('El adquiriente no tiene correo: indica uno para enviar la factura.');
      }
      if (para.length > 254 || !EMAIL.test(para)) throw new BadRequestException('El correo no es válido.');
      destino = enmascararCorreo(para);
      // El ZIP solo sale por defecto al adquiriente del documento; otro destino
      // exige además `einvoicing.configure` (evita sacar el archivo a cualquiera).
      if (personalizado && !user.permissions.includes(PERMISSIONS.EINVOICING_CONFIGURE)) {
        throw new ForbiddenException('Enviar a un correo distinto al del adquiriente requiere permiso de configuración.');
      }

      if (!doc.attachedPath) {
        // Entrega pendiente (p. ej. falló tras aceptar): se intenta una vez.
        await this.entrega.entregar(doc);
        doc = await this.cargar(id, user);
      }
      if (!doc.attachedPath) {
        throw new BadRequestException(
          'El archivo para el cliente (XML firmado y PDF) todavía no está listo. Regenera la entrega e inténtalo de nuevo.',
        );
      }

      await this.reservarEnvio(doc);
      let resultado;
      try {
        const zip = await this.storage.leerArtefactoGuardado(doc.attachedPath, documentoId, 'zip');
        resultado = await this.mail.sendFacturaElectronica({
          to: para,
          numero: doc.fullNumber,
          emisorNombre: doc.emisor?.name ?? 'Tu proveedor',
          total: this.cop(doc.total),
          zip,
          filename: `${doc.fullNumber}.zip`,
        });
      } catch (err) {
        await this.devolverEnvio(documentoId);
        throw err;
      }
      if (!resultado.sent && resultado.ambiguo) {
        // Sin respuesta de Resend: pudo salir. Cuenta como enviado (no se devuelve el cupo).
        await this.auditar(documentoId, user, 'POST', 'correo', false, `sin_respuesta:${destino}`);
        throw new ServiceUnavailableException(
          'No recibimos confirmación del envío: el correo pudo haber salido. Revisa con el cliente antes de reintentar.',
        );
      }
      if (!resultado.sent) {
        await this.devolverEnvio(documentoId);
        this.logger.warn(`Correo de ${documentoId} no enviado (${resultado.simulated ? 'simulado' : 'fallo'}).`);
        throw new ServiceUnavailableException('No se pudo enviar el correo. Inténtalo de nuevo en un momento.');
      }
      await this.model
        .updateOne(
          { _id: documentoId },
          { $set: { 'correoEntrega.ultimoPara': para, 'correoEntrega.personalizado': personalizado, 'correoEntrega.ultimoId': resultado.id ?? null } },
        )
        .exec();
      const enviados = this.enviosDe((await this.model.findById(documentoId).exec()) ?? doc);
      await this.auditar(documentoId, user, 'POST', 'correo', true, personalizado ? `otro:${destino}` : destino);
      return { enviado: true, para: destino, envios: enviados, restantes: Math.max(0, CORREO_MAX_ENVIOS - enviados) };
    } catch (err) {
      await this.auditar(documentoId, user, 'POST', 'correo', false, `${(err as Error)?.name ?? 'Error'}:${destino}`);
      throw err;
    }
  }

  /**
   * Reserva un envío con una sola escritura: solo pasa si el documento sigue
   * aceptado, no llegó al tope y pasó la espera mínima. Dos clics seguidos
   * mandan un solo correo.
   */
  private async reservarEnvio(doc: ElectronicDocumentDocument): Promise<void> {
    const ahora = new Date();
    const r = await this.model
      .updateOne(
        {
          _id: doc._id,
          dianStatus: 'accepted',
          $and: [
            { $or: [{ 'correoEntrega.envios': { $exists: false } }, { 'correoEntrega.envios': { $lt: CORREO_MAX_ENVIOS } }] },
            {
              $or: [
                { 'correoEntrega.ultimoAt': { $exists: false } },
                { 'correoEntrega.ultimoAt': { $lte: new Date(ahora.getTime() - CORREO_ESPERA_MS) } },
              ],
            },
          ],
        },
        { $inc: { 'correoEntrega.envios': 1 }, $set: { 'correoEntrega.ultimoAt': ahora } },
      )
      .exec();
    if (r.matchedCount === 1) return;
    const actual = (await this.model.findById(doc._id).exec()) ?? doc;
    const mensaje =
      this.enviosDe(actual) >= CORREO_MAX_ENVIOS
        ? `Este documento ya se envió ${CORREO_MAX_ENVIOS} veces: es el máximo.`
        : 'Se acaba de enviar este documento. Espera un minuto antes de reenviarlo.';
    throw new HttpException(mensaje, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** El correo no salió: el envío reservado no cuenta contra el tope. */
  private async devolverEnvio(documentoId: string): Promise<void> {
    await this.model
      .updateOne({ _id: documentoId, 'correoEntrega.envios': { $gt: 0 } }, { $inc: { 'correoEntrega.envios': -1 } })
      .exec()
      .catch(() => undefined);
  }

  private async cargar(id: string, user: JwtUser): Promise<ElectronicDocumentDocument> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).select('-respuestaDian.applicationResponse').exec()
      : null;
    if (!doc) throw new NotFoundException('Documento electrónico no encontrado');
    assertSedeAccess(user, doc.sedeId.toString());
    return doc;
  }

  private enviosDe(doc: ElectronicDocumentDocument): number {
    const n = Number(doc.correoEntrega?.envios ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  private fecha(v: unknown): Date | undefined {
    if (typeof v !== 'string' && !(v instanceof Date)) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  private cop(total: number): string {
    return `$ ${cop(Number(total) || 0).toLocaleString('es-CO')}`;
  }

  private async auditar(
    documentoId: string,
    user: JwtUser,
    method: 'GET' | 'POST',
    accion: 'descargas' | 'correo',
    success: boolean,
    codigo: string,
  ): Promise<void> {
    await this.audit.record({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      method,
      path: `/einvoicing/documentos/${documentoId}/${accion}`,
      success,
      action: `einvoicing.documento.${accion}`,
      // Nunca URLs firmadas ni rutas: solo el id y un código corto.
      detail: { documentoId, codigo: String(codigo).slice(0, 80) },
    });
  }
}
