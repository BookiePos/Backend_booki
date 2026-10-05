import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ElectronicDocument,
  ElectronicDocumentDocument,
} from '../infrastructure/schemas/electronic-document.schema';
import {
  Counter,
  CounterDocument,
} from '../../sales/infrastructure/schemas/counter.schema';
import { SalesService } from '../../sales/application/sales.service';
import { SedesService } from '../../sedes/application/sedes.service';
import { BusinessService } from '../../control/application/business.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { SaleDocument } from '../../sales/infrastructure/schemas/sale.schema';
import { SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';
import {
  CERT_DANGER_DAYS,
  CERT_WARN_DAYS,
  CONSUMIDOR_FINAL_NIT,
  CREDIT_NOTE_PREFIX,
  MEDIO_PAGO_BY_METHOD,
  PENDING_ALERT_HOURS,
  RETRY_DELAYS_MS,
} from '../domain/einvoicing.constants';
import { dianVerificationUrl } from '../domain/cufe';
import {
  computeResolutionStatus,
  type ResolutionStatus,
} from '../domain/resolution-status';
import { missingCustomerData } from '../domain/apidian-mapper';
import type { EinvoiceDocument } from '../domain/einvoice-document';
import type { SendOutcome } from '../domain/send-outcome';
import {
  EinvoiceConnection,
  EinvoicingAccountsService,
  normalizeNit,
} from './einvoicing-accounts.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cuántos pendientes se reintentan por empresa en cada barrido. */
const RETRY_BATCH = 50;

/** Una sede con su resolución y su estado, para la pantalla de control. */
export interface ResolutionRow {
  sedeId: string;
  sedeCode: string;
  sedeName: string;
  resolucion?: {
    numero?: string;
    fechaResolucion?: Date;
    prefijo?: string;
    rangoDesde?: number;
    rangoHasta?: number;
    vigenciaDesde?: Date;
    vigenciaHasta?: Date;
  };
  status: ResolutionStatus;
}

/** Datos con los que se registra o renueva una resolución. */
export interface RegisterResolutionInput {
  numero?: string;
  fechaResolucion?: string;
  prefijo?: string;
  rangoDesde?: number;
  rangoHasta?: number;
  vigenciaDesde?: string;
  vigenciaHasta?: string;
  claveTecnica?: string;
  /** Número por el que arranca el consecutivo. Por defecto, el inicio del rango. */
  empezarEn?: number;
}

/** Algo de la facturación electrónica que alguien tiene que mirar. */
export interface EinvoicingAlert {
  kind: 'certificate' | 'pending' | 'rejected';
  severity: 'warning' | 'danger';
  message: string;
  /** Documentos afectados (pendientes o rechazados). */
  count?: number;
  /** NIT afectado (certificado). */
  nit?: string;
}

/** Inicio y fin del día, para comparar vigencias sin que la hora estorbe. */
const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/**
 * Factura electrónica de venta y nota crédito, emitidas ante la DIAN.
 *
 * Quién firma y transmite (APIDIAN, o el simulado en desarrollo) lo decide el
 * módulo; este servicio solo habla con la interfaz `EinvoiceProvider` a
 * través de la conexión del NIT.
 */
@Injectable()
export class EinvoicingService {
  private readonly logger = new Logger(EinvoicingService.name);

  constructor(
    @InjectModel(ElectronicDocument.name)
    private readonly model: Model<ElectronicDocumentDocument>,
    @InjectModel(Counter.name)
    private readonly counters: Model<CounterDocument>,
    private readonly sales: SalesService,
    private readonly sedes: SedesService,
    private readonly businesses: BusinessService,
    private readonly accounts: EinvoicingAccountsService,
  ) {}

  /**
   * Cuenta el documento en el uso del mes. Los planes ya no tienen tope de
   * documentos, pero el mecanismo se conserva por si alguno vuelve a tenerlo.
   * Se llama ANTES de quemar el consecutivo DIAN.
   */
  private async consumeDocQuota(): Promise<void> {
    const ctx = TenantContext.current();
    if (ctx?.businessId) {
      await this.businesses.consumeDocument(ctx.businessId, ctx.plan);
    }
  }

  /** Documentos electrónicos de una sede (más recientes primero). */
  list(sedeId: string, user: JwtUser): Promise<ElectronicDocumentDocument[]> {
    assertSedeAccess(user, sedeId);
    return this.model
      .find({ sedeId: new Types.ObjectId(sedeId) })
      .sort({ createdAt: -1 })
      .limit(200)
      .exec();
  }

  async get(id: string, user: JwtUser): Promise<ElectronicDocumentDocument> {
    const doc = await this.getOrFail(id);
    assertSedeAccess(user, doc.sedeId.toString());
    return doc;
  }

  /**
   * Conexión con la DIAN para el NIT de la sede, o 400 claro si no la hay.
   *
   * Se pide ANTES de reservar el consecutivo: sin conexión el documento no
   * podría salir, y el número autorizado se habría gastado en nada.
   */
  private async connectionOrFail(sede: SedeDocument): Promise<EinvoiceConnection> {
    const conn = await this.accounts.connectionFor(sede.nit);
    if (!conn) {
      throw new BadRequestException(
        'Este NIT todavía no está conectado con la DIAN. Configúralo en Facturación electrónica > Conexión DIAN.',
      );
    }
    return conn;
  }

  /**
   * Genera la factura electrónica de una venta y la envía a la DIAN.
   *
   * El número se reserva primero y el documento queda guardado como `pending`
   * ANTES de enviarlo: si el envío falla a mitad de camino, el documento sigue
   * ahí con su número y se reintenta con el MISMO número, en vez de quemar otro.
   */
  async createFromSale(
    saleId: string,
    user: JwtUser,
  ): Promise<ElectronicDocumentDocument> {
    const sale = await this.sales.getOrFail(saleId);
    const sedeId = this.saleSedeId(sale);
    assertSedeAccess(user, sedeId);
    if (sale.status === 'void') {
      throw new BadRequestException(
        'No se puede facturar una venta anulada. Genera una nota crédito.',
      );
    }

    const existing = await this.model
      .findOne({ saleId: sale._id, type: 'invoice' })
      .exec();
    if (existing) return existing;

    const sede = await this.sedes.findOrFail(sedeId);

    // Nada de lo que sigue quema folio: el consecutivo autorizado por la DIAN
    // es un recurso escaso y no se gasta en un documento que no puede salir.
    if (!sede.resolucionFe?.claveTecnica) {
      throw new BadRequestException(
        'No se puede emitir: falta la clave técnica DIAN de la resolución de la sede.',
      );
    }
    this.assertResolucionVigente(sede);
    const adquiriente = this.buildAdquiriente(sale);
    const faltan = missingCustomerData({
      docNumber: adquiriente.docNumber,
      name: adquiriente.name,
      phone: adquiriente.phone,
      address: adquiriente.address,
    });
    if (faltan.length) {
      throw new BadRequestException(
        `Para facturar con los datos del cliente falta: ${faltan.join(', ')}. Complétalos o factura a consumidor final.`,
      );
    }
    const conn = await this.connectionOrFail(sede);

    await this.consumeDocQuota();

    const prefix = sede.resolucionFe.prefijo ?? '';
    const number = await this.nextNumber(
      `fe:${sedeId}:${prefix}`,
      sede.resolucionFe.rangoDesde ?? 1,
      sede.resolucionFe.rangoHasta,
    );
    const { issueDate, issueTime } = this.now();

    const lines = sale.lines.map((l) => ({
      code: l.sku,
      description: l.name,
      qty: l.qty,
      unitCode: '94',
      unitPrice: l.unitPrice,
      discountAmount: l.discountAmount ?? 0,
      base: l.taxBase ?? 0,
      taxKind: 'iva' as const,
      ivaRate: l.ivaRate ?? 0,
      ivaAmount: l.taxAmount ?? 0,
      total: round2((l.taxBase ?? 0) + (l.taxAmount ?? 0)),
    }));
    // El domicilio hace parte de la base gravable (DIAN, Oficio 664 de 2022):
    // va como una línea por cada tarifa en que se repartió.
    for (const p of sale.deliveryTaxes ?? []) {
      const gross = round2(p.base + p.amount);
      lines.push({
        code: 'DOMICILIO',
        description: 'Servicio de domicilio',
        qty: 1,
        unitCode: '94',
        unitPrice: gross,
        discountAmount: 0,
        base: p.base,
        taxKind: 'iva' as const,
        ivaRate: p.rate,
        ivaAmount: p.amount,
        total: gross,
      });
    }

    const doc = await this.model.create({
      type: 'invoice',
      saleId: sale._id,
      sedeId: new Types.ObjectId(sedeId),
      prefix: prefix || undefined,
      number,
      fullNumber: `${prefix}${number}`,
      issueDate,
      issueTime,
      emisor: this.buildEmisor(sede),
      adquiriente,
      lines,
      taxableBase: sale.taxableBase ?? 0,
      ivaTotal: sale.taxTotal ?? 0,
      discountTotal: sale.discountTotal ?? 0,
      // Lo facturado: las líneas más el domicilio. La propina va aparte.
      total: round2(sale.total + (sale.deliveryFee ?? 0)),
      tip: sale.tip ?? 0,
      formaPago: sale.payment.method === 'credit' ? '2' : '1',
      medioPago: MEDIO_PAGO_BY_METHOD[sale.payment.method] ?? '10',
      resolution: this.buildResolution(sede),
      dianStatus: 'pending',
      environment: conn.environment,
      technicalProvider: conn.provider.name,
      createdByEmail: user.email,
    });

    return this.transmit(doc, conn);
  }

  /**
   * Genera la nota crédito que anula una factura y la envía a la DIAN.
   *
   * Solo sobre facturas ACEPTADAS: la nota referencia el CUFE oficial, y una
   * factura que la DIAN nunca validó no se anula, se corrige y se reenvía.
   */
  async createCreditNote(
    invoiceId: string,
    reason: string,
    user: JwtUser,
  ): Promise<ElectronicDocumentDocument> {
    const invoice = await this.getOrFail(invoiceId);
    const sedeId = invoice.sedeId.toString();
    assertSedeAccess(user, sedeId);
    if (invoice.type !== 'invoice') {
      throw new BadRequestException('Solo se puede anular una factura de venta');
    }
    if (invoice.dianStatus !== 'accepted' || !invoice.cufe) {
      throw new BadRequestException(
        'Solo se anula con nota crédito una factura que la DIAN ya aceptó. Si fue rechazada, corrígela y reenvíala.',
      );
    }
    const already = await this.model
      .findOne({ referenceId: invoice._id, type: 'credit_note' })
      .exec();
    if (already) return already;

    const sede = await this.sedes.findOrFail(sedeId);
    const conn = await this.connectionOrFail(sede);

    // Una nota crédito también es un documento electrónico: cuenta al uso.
    await this.consumeDocQuota();

    // La numeración de notas es del NIT (así la registra el facturador), no de
    // la sede: dos sedes del mismo NIT no pueden emitir ambas la NC1.
    const nit = normalizeNit(sede.nit);
    const number = await this.nextNumber(`nc:nit:${nit}`, 1, undefined);
    const { issueDate, issueTime } = this.now();

    const doc = await this.model.create({
      type: 'credit_note',
      saleId: invoice.saleId,
      sedeId: invoice.sedeId,
      prefix: CREDIT_NOTE_PREFIX,
      number,
      fullNumber: `${CREDIT_NOTE_PREFIX}${number}`,
      issueDate,
      issueTime,
      emisor: invoice.emisor,
      adquiriente: invoice.adquiriente,
      lines: invoice.lines,
      taxableBase: invoice.taxableBase,
      ivaTotal: invoice.ivaTotal,
      discountTotal: invoice.discountTotal,
      total: invoice.total,
      tip: invoice.tip ?? 0,
      formaPago: invoice.formaPago,
      medioPago: invoice.medioPago,
      resolution: invoice.resolution,
      reason,
      referenceNumber: invoice.fullNumber,
      referenceCufe: invoice.cufe,
      referenceId: invoice._id,
      // La fecha de la factura viaja en la referencia de la nota.
      referenceIssueDate: invoice.issueDate,
      dianStatus: 'pending',
      environment: conn.environment,
      technicalProvider: conn.provider.name,
      createdByEmail: user.email,
    });

    return this.transmit(doc, conn);
  }

  /**
   * Reenvía un documento pendiente, rechazado o fallido, con su MISMO número.
   *
   * Antes de reenviar uno rechazado o fallido se refrescan los datos del
   * emisor desde la sede: si la DIAN lo rechazó por un dato fiscal mal
   * escrito, se corrige en la sede y se reintenta sin quemar otro consecutivo.
   */
  async retry(id: string, user: JwtUser): Promise<ElectronicDocumentDocument> {
    const doc = await this.get(id, user);
    if (doc.dianStatus === 'accepted') return doc;
    if (doc.dianStatus === 'draft') {
      throw new BadRequestException(
        'Este documento es de antes de la conexión con la DIAN y no se puede enviar.',
      );
    }
    const sede = await this.sedes.findOrFail(doc.sedeId.toString());
    if (doc.dianStatus !== 'pending') {
      doc.emisor = this.buildEmisor(sede);
    }
    const conn = await this.connectionOrFail(sede);
    return this.transmit(doc, conn);
  }

  /**
   * Reintenta los pendientes cuya hora llegó. Lo llama el barrido periódico por
   * cada empresa, dentro de su contexto.
   */
  async retryDue(): Promise<{ retried: number; accepted: number }> {
    const due = await this.model
      .find({ dianStatus: 'pending', nextAttemptAt: { $lte: new Date() } })
      .sort({ nextAttemptAt: 1 })
      .limit(RETRY_BATCH)
      .exec();
    let accepted = 0;
    for (const doc of due) {
      try {
        const sede = await this.sedes.findOrFail(doc.sedeId.toString());
        const conn = await this.accounts.connectionFor(sede.nit);
        if (!conn) {
          await this.applyOutcome(doc, undefined, {
            status: 'failed',
            message: 'El NIT perdió la conexión con la DIAN.',
            errors: [],
          });
          continue;
        }
        const out = await this.transmit(doc, conn);
        if (out.dianStatus === 'accepted') accepted++;
      } catch (err) {
        this.logger.error(
          `Reintento de ${doc.fullNumber} falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { retried: due.length, accepted };
  }

  /**
   * Lo que necesita atención, de lo más grave a lo menos: certificados por
   * vencer o vencidos (sin certificado no se factura), facturas pendientes
   * hace rato y facturas rechazadas o sin enviar.
   *
   * Solo mira las sedes que el usuario ve.
   */
  async alerts(user: JwtUser, now = new Date()): Promise<EinvoicingAlert[]> {
    const out: EinvoicingAlert[] = [];
    const MS_DIA = 24 * 60 * 60 * 1000;

    for (const a of await this.accounts.list(user)) {
      if (!a.certificateExpiresAt) continue;
      const restante = new Date(a.certificateExpiresAt).getTime() - now.getTime();
      // Hacia arriba mientras no vence ("vence en 10 días" aunque falten unas
      // horas menos) y hacia abajo una vez vencido.
      const dias = Math.ceil(restante / MS_DIA);
      if (restante < 0) {
        out.push({
          kind: 'certificate',
          severity: 'danger',
          nit: a.nit,
          message: `El certificado digital del NIT ${a.nit} venció hace ${Math.floor(-restante / MS_DIA)} día(s): no se puede facturar hasta renovarlo.`,
        });
      } else if (dias <= CERT_WARN_DAYS) {
        out.push({
          kind: 'certificate',
          severity: dias <= CERT_DANGER_DAYS ? 'danger' : 'warning',
          nit: a.nit,
          message: `El certificado digital del NIT ${a.nit} vence en ${dias} día(s). Renuévalo antes para no quedarse sin facturar.`,
        });
      }
    }

    const ids = allowedSedeIds(user);
    const scope = ids ? { sedeId: { $in: ids.map((id) => new Types.ObjectId(id)) } } : {};
    const [pendientes, rechazados] = await Promise.all([
      this.model
        .countDocuments({
          ...scope,
          dianStatus: 'pending',
          createdAt: { $lt: new Date(now.getTime() - PENDING_ALERT_HOURS * 3600 * 1000) },
        })
        .exec(),
      this.model
        .countDocuments({ ...scope, dianStatus: { $in: ['rejected', 'failed'] } })
        .exec(),
    ]);
    if (rechazados > 0) {
      out.push({
        kind: 'rejected',
        severity: 'danger',
        count: rechazados,
        message: `${rechazados} factura(s) rechazada(s) o sin enviar a la DIAN. Revisa el motivo y reenvíalas.`,
      });
    }
    if (pendientes > 0) {
      out.push({
        kind: 'pending',
        severity: 'warning',
        count: pendientes,
        message: `${pendientes} factura(s) llevan más de ${PENDING_ALERT_HOURS} horas sin confirmación de la DIAN. Se siguen reintentando solas.`,
      });
    }

    // Lo más grave primero.
    return out.sort(
      (x, y) => (x.severity === y.severity ? 0 : x.severity === 'danger' ? -1 : 1),
    );
  }

  /** PDF o XML del documento, tal como lo dejó el facturador. */
  async downloadFile(
    id: string,
    kind: 'pdf' | 'xml',
    user: JwtUser,
  ): Promise<{ data: Buffer; contentType: string; fileName: string }> {
    const doc = await this.get(id, user);
    const fileName = kind === 'pdf' ? doc.pdfFile : doc.xmlUrl;
    if (doc.dianStatus !== 'accepted' || !fileName) {
      throw new NotFoundException(
        'Este documento todavía no tiene archivo: la DIAN no lo ha aceptado.',
      );
    }
    const conn = await this.accounts.connectionFor(doc.emisor?.nit);
    if (!conn) {
      throw new ServiceUnavailableException('No hay conexión con el facturador.');
    }
    try {
      const file = await conn.provider.downloadFile(
        conn.token,
        normalizeNit(doc.emisor?.nit),
        fileName,
      );
      return { ...file, fileName };
    } catch (err) {
      throw new ServiceUnavailableException(
        err instanceof Error ? err.message : 'No se pudo descargar el archivo.',
      );
    }
  }

  // ── Envío ─────────────────────────────────────────────────────────────────────

  /**
   * Envía el documento y guarda lo que pasó. Nunca lanza por un problema de la
   * DIAN o del facturador: el resultado queda en el documento (aceptado,
   * rechazado, pendiente o fallido) y es lo que se devuelve.
   */
  private async transmit(
    doc: ElectronicDocumentDocument,
    conn: EinvoiceConnection,
  ): Promise<ElectronicDocumentDocument> {
    let outcome: SendOutcome;
    try {
      const payload = this.toEinvoiceDocument(doc);
      const opts = conn.testSetId ? { testSetId: conn.testSetId } : undefined;
      outcome =
        doc.type === 'invoice'
          ? await conn.provider.sendInvoice(conn.token, payload, opts)
          : await conn.provider.sendCreditNote(conn.token, payload, opts);
      // Ya había entrado: lo que vale es lo que la DIAN tiene, no reenviarlo.
      if (outcome.status === 'duplicate' && outcome.cufe) {
        outcome = await conn.provider.getStatus(conn.token, outcome.cufe);
      } else if (outcome.status === 'duplicate') {
        outcome = { ...outcome, status: 'pending' };
      }
    } catch (err) {
      outcome = {
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
        errors: [],
      };
    }
    return this.applyOutcome(doc, conn, outcome);
  }

  private async applyOutcome(
    doc: ElectronicDocumentDocument,
    conn: EinvoiceConnection | undefined,
    outcome: SendOutcome,
  ): Promise<ElectronicDocumentDocument> {
    const attempts = (doc.attempts ?? 0) + 1;
    doc.attempts = attempts;
    doc.lastAttemptAt = new Date();
    doc.dianMessage = outcome.message;
    doc.dianErrors = outcome.errors;
    if (conn) {
      doc.technicalProvider = conn.provider.name;
      doc.environment = conn.environment;
    }

    switch (outcome.status) {
      case 'accepted':
        doc.dianStatus = 'accepted';
        doc.cufe = outcome.cufe ?? doc.cufe;
        doc.qrUrl =
          outcome.qrUrl ??
          (doc.cufe ? dianVerificationUrl(doc.cufe, doc.environment) : undefined);
        doc.pdfFile = outcome.files?.pdf ?? doc.pdfFile;
        doc.xmlUrl = outcome.files?.xml ?? doc.xmlUrl;
        doc.validatedAt = new Date();
        doc.nextAttemptAt = undefined;
        break;
      case 'rejected':
      case 'failed':
        doc.dianStatus = outcome.status;
        if (outcome.cufe) doc.cufe = outcome.cufe;
        doc.nextAttemptAt = undefined;
        break;
      default: {
        // Pendiente (o duplicado sin CUFE): espera creciente y, agotada la
        // lista, queda quieto hasta que alguien lo reenvíe a mano.
        doc.dianStatus = 'pending';
        if (outcome.cufe) doc.cufe = outcome.cufe;
        const delay = RETRY_DELAYS_MS[attempts - 1];
        doc.nextAttemptAt =
          delay !== undefined ? new Date(Date.now() + delay) : undefined;
      }
    }
    await doc.save();
    if (doc.dianStatus !== 'accepted') {
      this.logger.warn(
        `${doc.fullNumber} quedó ${doc.dianStatus}: ${outcome.message} ${outcome.errors.join(' | ')}`,
      );
    }
    return doc;
  }

  /** El documento guardado, en la forma que se le entrega al proveedor. */
  private toEinvoiceDocument(doc: ElectronicDocumentDocument): EinvoiceDocument {
    const a = doc.adquiriente;
    const consumidorFinal = !a?.docNumber || a.docNumber === CONSUMIDOR_FINAL_NIT;
    const method =
      Object.entries(MEDIO_PAGO_BY_METHOD).find(
        ([, code]) => code === doc.medioPago,
      )?.[0] ?? 'cash';
    return {
      kind: doc.type,
      prefix: doc.prefix ?? '',
      number: doc.number,
      resolutionNumber:
        doc.type === 'invoice' ? doc.resolution?.numero : undefined,
      issueDate: doc.issueDate,
      issueTime: doc.issueTime.slice(0, 8),
      issuer: {
        nit: normalizeNit(doc.emisor?.nit),
        dv: doc.emisor?.nitDv,
        name: doc.emisor?.name ?? '',
        address: doc.emisor?.address,
        phone: doc.emisor?.phone,
        email: doc.emisor?.email,
        departamento: doc.emisor?.departamento,
        ciudad: doc.emisor?.ciudad,
      },
      customer: consumidorFinal
        ? {}
        : {
            docType: a?.docType,
            docNumber: a?.docNumber,
            name: a?.name,
            phone: a?.phone,
            email: a?.email,
            address: a?.address,
          },
      lines: doc.lines.map((l) => ({
        code: l.code ?? '',
        description: l.description,
        qty: l.qty,
        grossTotal: round2(l.qty * l.unitPrice),
        base: l.base,
        taxKind: l.taxKind ?? 'iva',
        taxRate: l.ivaRate ?? 0,
        taxAmount: l.ivaAmount ?? 0,
      })),
      paymentMethod: doc.formaPago === '2' ? 'credit' : method,
      tip: doc.tip ?? 0,
      reference:
        doc.type === 'credit_note' && doc.referenceCufe
          ? {
              fullNumber: doc.referenceNumber ?? '',
              cufe: doc.referenceCufe,
              issueDate: doc.referenceIssueDate ?? doc.issueDate,
            }
          : undefined,
      reason: doc.reason,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async getOrFail(id: string): Promise<ElectronicDocumentDocument> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).exec()
      : null;
    if (!doc) throw new NotFoundException('Documento no encontrado');
    return doc;
  }

  private saleSedeId(sale: SaleDocument): string {
    const raw = sale.sedeId as unknown as { _id?: Types.ObjectId };
    return (raw._id ?? (sale.sedeId as unknown as Types.ObjectId)).toString();
  }

  /**
   * Rechaza la emisión si la resolución no está vigente hoy.
   *
   * Se llama antes de consumir cupo y antes de quemar folio: el consecutivo
   * autorizado es un recurso escaso y no se gasta en una factura que no se
   * debería estar emitiendo.
   */
  private assertResolucionVigente(sede: SedeDocument): void {
    const r = sede.resolucionFe;
    const hoy = new Date();
    if (r?.vigenciaHasta && new Date(r.vigenciaHasta) < startOfDay(hoy)) {
      throw new BadRequestException(
        'La resolución de numeración de esta sede está vencida. Renuévala ante la DIAN antes de seguir facturando.',
      );
    }
    if (r?.vigenciaDesde && new Date(r.vigenciaDesde) > endOfDay(hoy)) {
      throw new BadRequestException(
        'La vigencia de la resolución de numeración de esta sede todavía no ha empezado.',
      );
    }
  }

  /**
   * Estado de la resolución de cada sede: qué queda de rango, cuánto de
   * vigencia y si se puede emitir.
   *
   * Es la información que hasta ahora no se veía por ningún lado: el
   * consecutivo vive en un contador atómico, no en la sede, así que nadie sabía
   * por qué número iba ni cuántos quedaban hasta que se acababan.
   */
  async resolutionStatus(user: JwtUser): Promise<ResolutionRow[]> {
    const sedes = await this.sedes.list(allowedSedeIds(user));
    return Promise.all(
      sedes.map(async (sede) => {
        const r = sede.resolucionFe;
        const siguiente = r
          ? await this.peekNumber(sede.id as string, r.prefijo, r.rangoDesde)
          : undefined;
        return {
          sedeId: sede.id as string,
          sedeCode: sede.code,
          sedeName: sede.name,
          // La clave técnica NO viaja: solo si está puesta, dentro del estado.
          resolucion: r
            ? {
                numero: r.numero,
                fechaResolucion: r.fechaResolucion,
                prefijo: r.prefijo,
                rangoDesde: r.rangoDesde,
                rangoHasta: r.rangoHasta,
                vigenciaDesde: r.vigenciaDesde,
                vigenciaHasta: r.vigenciaHasta,
              }
            : undefined,
          status: computeResolutionStatus(r, siguiente),
        };
      }),
    );
  }

  /**
   * Registra una resolución nueva y **ancla el consecutivo** donde corresponde.
   *
   * Esto último es la razón de ser del endpoint. El contador va por
   * `fe:<sede>:<prefijo>` y el número se calcula como `rangoDesde + seq - 1`:
   * al renovar con el mismo prefijo, el contador seguía donde estaba mientras
   * `rangoDesde` cambiaba, así que la numeración saltaba (ibas por la 500 del
   * rango 1-2000, renovabas a 2001-4000 y la siguiente salía 2500, comiéndose
   * 499 números autorizados). Fijando `seq` al registrar, la próxima factura
   * sale con el número que se pide.
   *
   * Si el NIT ya está conectado con la DIAN, la resolución nueva también se
   * registra en el facturador; si eso falla, la resolución queda guardada aquí
   * y se puede volver a sincronizar desde la conexión.
   */
  async registerResolution(
    sedeId: string,
    dto: RegisterResolutionInput,
    user: JwtUser,
  ): Promise<ResolutionRow[]> {
    assertSedeAccess(user, sedeId);
    const sede = await this.sedes.findOrFail(sedeId);

    const desde = dto.rangoDesde ?? 1;
    const empezarEn = dto.empezarEn ?? desde;
    if (empezarEn < desde || (dto.rangoHasta != null && empezarEn > dto.rangoHasta)) {
      throw new BadRequestException(
        'El número inicial tiene que estar dentro del rango autorizado.',
      );
    }

    sede.resolucionFe = {
      numero: dto.numero,
      fechaResolucion: dto.fechaResolucion
        ? new Date(dto.fechaResolucion)
        : undefined,
      prefijo: dto.prefijo?.toUpperCase(),
      rangoDesde: desde,
      rangoHasta: dto.rangoHasta,
      vigenciaDesde: dto.vigenciaDesde ? new Date(dto.vigenciaDesde) : undefined,
      vigenciaHasta: dto.vigenciaHasta ? new Date(dto.vigenciaHasta) : undefined,
      // La clave técnica se conserva si no viene una nueva: es un dato que se
      // teclea una vez y perderlo dejaría la sede sin poder emitir.
      claveTecnica: dto.claveTecnica ?? sede.resolucionFe?.claveTecnica,
    };
    await sede.save();

    await this.counters
      .findOneAndUpdate(
        { _id: `fe:${sedeId}:${sede.resolucionFe.prefijo ?? ''}` },
        { $set: { seq: empezarEn - desde } },
        { upsert: true },
      )
      .exec();

    if (await this.accounts.connectionFor(sede.nit).catch(() => undefined)) {
      try {
        await this.accounts.syncResolutions(sedeId, user);
      } catch (err) {
        this.logger.warn(
          `La resolución de la sede ${sede.code} quedó guardada pero no se pudo registrar en el facturador: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return this.resolutionStatus(user);
  }

  /**
   * Qué número le tocaría a la próxima factura, SIN consumirlo.
   * Leer el contador no lo incrementa; el `$inc` solo ocurre al emitir.
   */
  private async peekNumber(
    sedeId: string,
    prefijo: string | undefined,
    rangoDesde: number | undefined,
  ): Promise<number> {
    const counter = await this.counters
      .findById(`fe:${sedeId}:${prefijo ?? ''}`)
      .exec();
    return (rangoDesde ?? 1) + (counter?.seq ?? 0);
  }

  /** Consecutivo dentro del rango autorizado (o libre para notas). */
  private async nextNumber(
    counterId: string,
    desde: number,
    hasta: number | undefined,
  ): Promise<number> {
    const counter = await this.counters
      .findOneAndUpdate(
        { _id: counterId },
        { $inc: { seq: 1 } },
        { upsert: true, new: true },
      )
      .exec();
    const number = desde + counter.seq - 1;
    if (hasta != null && number > hasta) {
      throw new ConflictException(
        'Se agotó el rango de numeración autorizado por la DIAN para esta sede.',
      );
    }
    return number;
  }

  private buildEmisor(sede: SedeDocument) {
    return {
      name: sede.businessName || sede.name,
      nit: sede.nit,
      nitDv: sede.nitDv,
      tipoPersona: sede.tipoPersona,
      responsabilidadFiscal: sede.responsabilidadFiscal,
      ciiu: sede.ciiu,
      address: sede.address,
      departamento: sede.departamento,
      ciudad: sede.ciudad,
      phone: sede.phone,
      email: sede.emailFacturacion,
    };
  }

  private buildAdquiriente(sale: SaleDocument) {
    const c = sale.customer;
    if (!c || (!c.name && !c.idNumber)) {
      return { docType: '13', docNumber: CONSUMIDOR_FINAL_NIT, name: 'Consumidor final' };
    }
    const num = (c.idNumber ?? '').replace(/\s/g, '');
    // Si el POS no mandó el tipo, se deduce: un número con DV ("900…-7") o de
    // 9 dígitos que empieza por 8 o 9 es NIT; lo demás, cédula.
    const digits = (num.split('-')[0] ?? '').replace(/\D/g, '');
    const pareceNit =
      num.includes('-') || (digits.length === 9 && /^[89]/.test(digits));
    const docType = c.idType ?? (pareceNit ? '31' : '13');
    return {
      docType,
      docNumber: num || CONSUMIDOR_FINAL_NIT,
      name: c.name || 'Consumidor final',
      phone: c.phone,
      email: c.email,
      address: c.address,
    };
  }

  private buildResolution(sede: SedeDocument) {
    const r = sede.resolucionFe;
    if (!r) return undefined;
    return {
      numero: r.numero,
      prefijo: r.prefijo,
      rangoDesde: r.rangoDesde,
      rangoHasta: r.rangoHasta,
      vigenciaDesde: r.vigenciaDesde,
      vigenciaHasta: r.vigenciaHasta,
    };
  }

  /** Fecha/hora en zona Colombia (UTC-5, sin DST). */
  private now(): { issueDate: string; issueTime: string } {
    const shifted = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    return {
      issueDate: shifted.slice(0, 10),
      issueTime: `${shifted.slice(11, 19)}-05:00`,
    };
  }
}
