import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
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
  CONSUMIDOR_FINAL_NIT,
  MEDIO_PAGO_BY_METHOD,
} from '../domain/einvoicing.constants';
import { computeCufe, dianVerificationUrl } from '../domain/cufe';
import {
  computeResolutionStatus,
  type ResolutionStatus,
} from '../domain/resolution-status';

const round2 = (n: number) => Math.round(n * 100) / 100;

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

/** Inicio y fin del día, para comparar vigencias sin que la hora estorbe. */
const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

@Injectable()
export class EinvoicingService {
  constructor(
    @InjectModel(ElectronicDocument.name)
    private readonly model: Model<ElectronicDocumentDocument>,
    @InjectModel(Counter.name)
    private readonly counters: Model<CounterDocument>,
    private readonly sales: SalesService,
    private readonly sedes: SedesService,
    private readonly businesses: BusinessService,
  ) {}

  /**
   * Descuenta un documento del cupo del plan (o de los créditos comprados).
   * Se llama ANTES de quemar el consecutivo DIAN: si no hay cupo, aborta con 402
   * sin consumir folio. Fail-open si la request no trae empresa en contexto.
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

  /** Genera (o devuelve si ya existe) la factura electrónica de una venta. */
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

    // No quemar folio en un documento inválido: sin clave técnica no se puede
    // calcular el CUFE (ni el QR), y el consecutivo del rango autorizado por la
    // DIAN es un recurso escaso. Validamos ANTES de incrementar el contador; si
    // falta, se aborta sin consumir número.
    if (!sede.resolucionFe?.claveTecnica) {
      throw new BadRequestException(
        'No se puede emitir: falta la clave técnica DIAN de la sede para calcular el CUFE.',
      );
    }

    // La vigencia también se comprueba antes de tocar nada. Una resolución
    // vencida no autoriza a facturar, y sin esto el sistema seguía emitiendo
    // con normalidad e imprimiendo en cada factura una vigencia ya expirada.
    this.assertResolucionVigente(sede);

    // Cupo de documentos del plan (antes de quemar folio: si no hay cupo, 402).
    await this.consumeDocQuota();

    const prefix = sede.resolucionFe.prefijo ?? '';
    const number = await this.nextNumber(
      `fe:${sedeId}:${prefix}`,
      sede.resolucionFe.rangoDesde ?? 1,
      sede.resolucionFe.rangoHasta,
    );
    const fullNumber = `${prefix}${number}`;
    const { issueDate, issueTime } = this.now();

    const lines = sale.lines.map((l) => {
      const net = round2(l.taxBase + l.taxAmount);
      return {
        code: l.sku,
        description: l.name,
        qty: l.qty,
        unitCode: '94',
        unitPrice: l.unitPrice,
        discountAmount: l.discountAmount ?? 0,
        base: l.taxBase ?? 0,
        ivaRate: l.ivaRate ?? 0,
        ivaAmount: l.taxAmount ?? 0,
        total: net,
      };
    });

    const adquiriente = this.buildAdquiriente(sale);
    const emisor = this.buildEmisor(sede);
    const medioPago = MEDIO_PAGO_BY_METHOD[sale.payment.method] ?? '10';

    // CUFE (Anexo 1.9). La clave técnica ya se validó arriba (folio no quemado).
    const cufe = computeCufe({
      numFac: fullNumber,
      fecFac: issueDate,
      horFac: issueTime,
      valFac: sale.taxableBase ?? 0,
      valIva: sale.taxTotal ?? 0,
      valTot: sale.total,
      nitOFE: (sede.nit ?? '').replace(/\D/g, ''),
      numAdq: adquiriente.docNumber ?? CONSUMIDOR_FINAL_NIT,
      claveTecnica: sede.resolucionFe.claveTecnica,
    });
    const qrUrl = dianVerificationUrl(cufe);

    return this.model.create({
      type: 'invoice',
      saleId: sale._id,
      sedeId: new Types.ObjectId(sedeId),
      prefix: prefix || undefined,
      number,
      fullNumber,
      issueDate,
      issueTime,
      emisor,
      adquiriente,
      lines,
      taxableBase: sale.taxableBase ?? 0,
      ivaTotal: sale.taxTotal ?? 0,
      discountTotal: sale.discountTotal ?? 0,
      total: sale.total,
      formaPago: '1',
      medioPago,
      resolution: this.buildResolution(sede),
      cufe,
      qrUrl,
      dianStatus: 'draft',
      createdByEmail: user.email,
    });
  }

  /** Genera la nota crédito que anula/corrige una factura ya emitida. */
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

    const sede = await this.sedes.findOrFail(sedeId);

    // Igual que en la factura: sin clave técnica no hay CUFE, así que no se
    // consume el consecutivo de la nota crédito. Validar ANTES de nextNumber.
    if (!sede.resolucionFe?.claveTecnica) {
      throw new BadRequestException(
        'No se puede emitir: falta la clave técnica DIAN de la sede para calcular el CUFE.',
      );
    }

    // Una nota crédito también es un documento electrónico: cuenta al cupo.
    await this.consumeDocQuota();

    const number = await this.nextNumber(`nc:${sedeId}`, 1, undefined);
    const fullNumber = `NC${number}`;
    const { issueDate, issueTime } = this.now();

    const cufe = computeCufe({
      numFac: fullNumber,
      fecFac: issueDate,
      horFac: issueTime,
      valFac: invoice.taxableBase,
      valIva: invoice.ivaTotal,
      valTot: invoice.total,
      nitOFE: (sede.nit ?? '').replace(/\D/g, ''),
      numAdq: invoice.adquiriente?.docNumber ?? CONSUMIDOR_FINAL_NIT,
      claveTecnica: sede.resolucionFe.claveTecnica,
    });
    const qrUrl = dianVerificationUrl(cufe);

    return this.model.create({
      type: 'credit_note',
      saleId: invoice.saleId,
      sedeId: invoice.sedeId,
      prefix: 'NC',
      number,
      fullNumber,
      issueDate,
      issueTime,
      emisor: invoice.emisor,
      adquiriente: invoice.adquiriente,
      lines: invoice.lines,
      taxableBase: invoice.taxableBase,
      ivaTotal: invoice.ivaTotal,
      discountTotal: invoice.discountTotal,
      total: invoice.total,
      formaPago: invoice.formaPago,
      medioPago: invoice.medioPago,
      resolution: invoice.resolution,
      reason,
      referenceNumber: invoice.fullNumber,
      referenceCufe: invoice.cufe,
      referenceId: invoice._id,
      cufe,
      qrUrl,
      dianStatus: 'draft',
      createdByEmail: user.email,
    });
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

  /** Consecutivo dentro del rango autorizado (o libre para notas). */
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
    // Heurística simple: > 10 dígitos ⇒ NIT (31); si no, cédula (13).
    const docType = num.replace(/\D/g, '').length > 10 ? '31' : '13';
    return {
      docType,
      docNumber: num || CONSUMIDOR_FINAL_NIT,
      name: c.name || 'Consumidor final',
      phone: c.phone,
      email: c.email,
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
