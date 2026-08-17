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
import { SaleDocument } from '../../sales/infrastructure/schemas/sale.schema';
import { SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import {
  CONSUMIDOR_FINAL_NIT,
  MEDIO_PAGO_BY_METHOD,
} from '../domain/einvoicing.constants';
import { computeCufe, dianVerificationUrl } from '../domain/cufe';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class EinvoicingService {
  constructor(
    @InjectModel(ElectronicDocument.name)
    private readonly model: Model<ElectronicDocumentDocument>,
    @InjectModel(Counter.name)
    private readonly counters: Model<CounterDocument>,
    private readonly sales: SalesService,
    private readonly sedes: SedesService,
  ) {}

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
