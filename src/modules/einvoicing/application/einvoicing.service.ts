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
import {
  ResolucionFe,
  SedeDocument,
} from '../../sedes/infrastructure/schemas/sede.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';
import {
  adquirientePos,
  buildAdquiriente,
  validarAdquirienteParaFactura,
} from '../domain/adquiriente';
import {
  cajaVentaPos,
  fabricanteDesdeEntorno,
  pagosPos,
  type ModoPos,
} from '../domain/emision-pos';
import {
  CONSUMIDOR_FINAL_NIT,
  MEDIO_PAGO_BY_METHOD,
} from '../domain/einvoicing.constants';
import {
  calcularCude,
  calcularCudePos,
  calcularCufe,
  dianVerificationUrl,
} from '../domain/cufe';
import {
  documentoDeVenta,
  DocumentoDescuadradoError,
  type DocumentoDeVenta,
} from '../domain/documento-venta';
import { aCentavos } from '../domain/redondeo';
import { hasCreditPart } from '../../sales/domain/sale-payments';
import { causesInc } from '../../core-tax/domain/sale-tax';
import type { BusinessType } from '../../control/domain/control.constants';
import {
  TIPO_AMBIENTE_POR_DEFECTO,
  type TipoAmbiente,
} from '../domain/emisor-fiscal';
import { FiscalEmittersService } from './fiscal-emitters.service';
import {
  normalizarNit,
  tipoDeChoque,
  TIPOS_EXCLUYENTES_POR_VENTA,
} from '../domain/consecutivo-unico';
import {
  computeResolutionStatus,
  type ResolutionStatus,
} from '../domain/resolution-status';
import {
  contadorDeResolucion,
  NOMBRE_TIPO_RESOLUCION,
  resolucionDeTipo,
  TIPO_RESOLUCION_POR_DEFECTO,
  type TipoResolucion,
} from '../domain/resolucion-tipos';

/** Rechazo de la nota cuando el emisor no tiene PIN: sin él no hay CUDE. */
export const MENSAJE_NOTA_SIN_PIN =
  'Carga el PIN del software DIAN del emisor antes de emitir notas.';

/** Rechazo del POS cuando el emisor no tiene PIN: sin él no hay CUDE (§14.1.3). */
export const MENSAJE_POS_SIN_PIN =
  'No se puede emitir el documento POS: carga el PIN del software DIAN del emisor.';

/** La venta ya tiene el otro documento fiscal (D1: POS o FEV, nunca los dos). */
export const MENSAJE_EXCLUSION_POS_FEV: Record<'pos' | 'invoice', string> = {
  pos: 'Esta venta ya tiene factura electrónica: no se le puede emitir también el documento POS.',
  invoice:
    'Esta venta ya tiene documento equivalente POS. Para facturarla, anula primero el POS con una nota de ajuste.',
};

/** Lo de una resolución que viaja a la pantalla (la clave técnica NO viaja). */
export interface ResolucionVista {
  numero?: string;
  fechaResolucion?: Date;
  prefijo?: string;
  rangoDesde?: number;
  rangoHasta?: number;
  vigenciaDesde?: Date;
  vigenciaHasta?: Date;
}

/** Resolución de un tipo de documento distinto de la factura, con su estado. */
export interface ResolutionTipoRow {
  tipoDocumento: TipoResolucion;
  resolucion: ResolucionVista;
  status: ResolutionStatus;
}

/**
 * Una sede con su resolución y su estado, para la pantalla de control.
 * `resolucion` y `status` son los de la factura (compatible con el cliente
 * anterior); las de los demás tipos van en `otras`.
 */
export interface ResolutionRow {
  sedeId: string;
  sedeCode: string;
  sedeName: string;
  tipoDocumento: 'invoice';
  resolucion?: ResolucionVista;
  status: ResolutionStatus;
  otras: ResolutionTipoRow[];
}

/** Datos con los que se registra o renueva una resolución. */
export interface RegisterResolutionInput {
  /** Tipo de documento. Por defecto `invoice`. */
  tipoDocumento?: TipoResolucion;
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

/** El XML de la DIAN (base64, hasta ~1 MB) lo lee la entrega; la API no lo devuelve. */
const SIN_APPLICATION_RESPONSE = '-respuestaDian.applicationResponse';

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
    private readonly emisores: FiscalEmittersService,
  ) {}

  /** Ambiente del emisor fiscal de la sede; sin emisor, habilitación ('2'). */
  private ambienteDe(emisor: { tipoAmbiente?: string } | null): TipoAmbiente {
    return emisor?.tipoAmbiente === '1' ? '1' : TIPO_AMBIENTE_POR_DEFECTO;
  }

  /** NIT del emisor para el CUFE/CUDE: solo dígitos y sin DV. Se valida antes del folio. */
  private nitParaCodigo(nit: string | undefined): string {
    const norm = normalizarNit(nit);
    if (!norm) {
      throw new BadRequestException(
        'No se puede emitir: la sede no tiene NIT. Complétalo en los datos fiscales de la sede.',
      );
    }
    return norm;
  }

  /**
   * Líneas y totales de la venta (`domain/documento-venta.ts`). Un descuadre,
   * consigo mismo o con lo cobrado, es un 400 antes de cupo y folio.
   */
  private async armarDocumento(
    sale: SaleDocument,
    sede: SedeDocument,
  ): Promise<DocumentoDeVenta> {
    // Si el negocio causa INC lo decide `causesInc` con el perfil de la sede
    // (art. 512-13 ET: sin dato de responsabilidad, el restaurante lo causa),
    // o lo dicen las propias líneas de la venta.
    const causaInc =
      causesInc({
        tipoNegocio: await this.tipoNegocio(),
        responsabilidadFiscal: sede.responsabilidadFiscal,
        responsableIva: sede.responsableIva,
        responsableInc: sede.responsableInc,
        franquicia: sede.franquicia,
      }) || sale.lines.some((l) => l.taxKind === 'inc');
    try {
      return documentoDeVenta(sale, { causaInc });
    } catch (err) {
      if (err instanceof DocumentoDescuadradoError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /** Giro de la empresa activa (como en `SalesService`). */
  private async tipoNegocio(): Promise<BusinessType | undefined> {
    const ctx = TenantContext.current();
    if (!ctx) return undefined;
    if (ctx.tipoNegocio) return ctx.tipoNegocio;
    const business = await this.businesses.findById(ctx.businessId);
    return business?.tipoNegocio;
  }

  /** Documento del adquiriente para el CUFE/CUDE: el NIT va sin DV. */
  private numeroAdquiriente(a?: { docType?: string; docNumber?: string }): string {
    const n = a?.docNumber?.trim();
    if (!n) return CONSUMIDOR_FINAL_NIT;
    return a?.docType === '31' ? (normalizarNit(n) ?? n) : n;
  }

  /**
   * Descuenta un documento del cupo del plan (o de los créditos comprados).
   * Se llama ANTES de quemar el consecutivo DIAN: si no hay cupo, aborta con 402
   * sin consumir folio. Fail-open si la request no trae empresa en contexto.
   */
  private async consumeDocQuota(): Promise<'monthly' | 'credit' | undefined> {
    const ctx = TenantContext.current();
    if (ctx?.businessId) {
      return this.businesses.consumeDocument(ctx.businessId, ctx.plan);
    }
    return undefined;
  }

  /** Devuelve al cupo lo cobrado por `consumeDocQuota` cuando la emisión falló. */
  private async refundDocQuota(
    origen: 'monthly' | 'credit' | undefined,
  ): Promise<void> {
    const ctx = TenantContext.current();
    if (origen && ctx?.businessId) {
      await this.businesses.refundDocument(ctx.businessId, origen);
    }
  }

  /** Objeto plano de un subdocumento (o el mismo valor si ya lo es). */
  private plano<T>(valor: T): Record<string, unknown> | undefined {
    const v = valor as unknown as { toObject?: () => Record<string, unknown> };
    return v && typeof v.toObject === 'function'
      ? v.toObject()
      : (valor as unknown as Record<string, unknown> | undefined);
  }

  /**
   * Cobra el cupo, toma el folio y guarda el documento. Si la inserción falla,
   * NUNCA deja cobrado el cupo ni gastado el folio por culpa del índice:
   * - choque por número (`consecutivo_unico`): el contador iba por detrás de lo
   *   ya emitido (renovación con otro prefijo, dos sedes con el mismo NIT...);
   *   se sube al mayor número emitido para (NIT, prefijo) y se reintenta, hasta
   *   3 intentos en total;
   * - choque por venta+tipo (doble emisión en carrera): se devuelve el
   *   documento que ya existe;
   * - cualquier otro error: se relanza, con cupo y folio devueltos.
   */
  private async emitir(o: {
    counterId: string;
    desde: number;
    hasta: number | undefined;
    prefix: string;
    nit: string | undefined;
    construir: (number: number) => Record<string, unknown>;
    existente: () => Promise<ElectronicDocumentDocument | null>;
    /** Mensaje del 409 si choca la exclusión POS/FEV con el otro tipo. */
    exclusion?: string;
  }): Promise<ElectronicDocumentDocument> {
    const MAX_INTENTOS = 3;
    for (let intento = 1; ; intento++) {
      // Cupo del plan antes de quemar folio: si no hay cupo, 402 sin consumir nada.
      const origen = await this.consumeDocQuota();
      let number: number | undefined;
      try {
        number = await this.nextNumber(o.counterId, o.desde, o.hasta);
        return await this.model.create(o.construir(number));
      } catch (err) {
        await this.refundDocQuota(origen);
        const choque = tipoDeChoque(err);
        if (number !== undefined && choque !== 'consecutivo') {
          await this.devolverFolio(o.counterId, number - o.desde + 1);
        }
        if (choque === 'venta' || choque === 'exclusion') {
          const existente = await o.existente();
          if (existente) return existente;
        }
        // Otra emisión de la misma venta ganó con el OTRO tipo (POS frente a
        // FEV): cupo y folio ya volvieron; se responde 409, nunca los dos.
        if (choque === 'exclusion' && o.exclusion) {
          throw new ConflictException(o.exclusion);
        }
        if (choque === 'consecutivo' && intento < MAX_INTENTOS) {
          await this.subirContador(o);
          continue;
        }
        if (choque === 'consecutivo') {
          throw new ConflictException(
            'No se pudo asignar un número libre. Revisa la numeración de la sede e inténtalo de nuevo.',
          );
        }
        throw err;
      }
    }
  }

  /** Mayor número ya emitido para (NIT normalizado, prefijo), o 0 si no hay. */
  private async mayorNumeroEmitido(
    nit: string | undefined,
    prefijo: string,
  ): Promise<number> {
    const norm = normalizarNit(nit);
    if (!norm) return 0;
    const ultimo = await this.model
      .findOne({
        prefix: prefijo || null,
        // `nitNorm` en los nuevos; `nit` tal cual en los que aún no se rellenaron.
        $or: [{ 'emisor.nitNorm': norm }, { 'emisor.nit': nit }],
      })
      .sort({ number: -1 })
      .select('number')
      .lean()
      .exec();
    return ultimo?.number ?? 0;
  }

  /** Sube el contador al mayor número emitido (nunca lo baja). */
  private async subirContador(o: {
    counterId: string;
    desde: number;
    prefix: string;
    nit: string | undefined;
  }): Promise<void> {
    const mayor = await this.mayorNumeroEmitido(o.nit, o.prefix);
    if (mayor < o.desde) return;
    await this.counters
      .findOneAndUpdate(
        { _id: o.counterId },
        { $max: { seq: mayor - o.desde + 1 } },
        { upsert: true },
      )
      .exec();
  }

  /**
   * Devuelve el folio tomado, solo si nadie tomó otro después (el contador
   * sigue en `seq`): bajarlo a ciegas pisaría el número de otra emisión.
   */
  private async devolverFolio(counterId: string, seq: number): Promise<void> {
    await this.counters
      .findOneAndUpdate({ _id: counterId, seq }, { $inc: { seq: -1 } })
      .exec();
  }

  /** Documentos electrónicos de una sede (más recientes primero). */
  list(sedeId: string, user: JwtUser): Promise<ElectronicDocumentDocument[]> {
    assertSedeAccess(user, sedeId);
    return this.model
      .find({ sedeId: new Types.ObjectId(sedeId) })
      .select(SIN_APPLICATION_RESPONSE)
      .sort({ createdAt: -1 })
      .limit(200)
      .exec();
  }

  async get(id: string, user: JwtUser): Promise<ElectronicDocumentDocument> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).select(SIN_APPLICATION_RESPONSE).exec()
      : null;
    if (!doc) throw new NotFoundException('Documento no encontrado');
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

    // Idempotente por venta+tipo, y excluyente con el POS (D1).
    const existing = await this.documentoFiscalDeVenta(sale._id, 'invoice');
    if (existing) return existing;

    const sede = await this.sedes.findOrFail(sedeId);
    const resolucion = resolucionDeTipo(sede, 'invoice');

    // No quemar folio en un documento inválido: sin clave técnica no se puede
    // calcular el CUFE (ni el QR), y el consecutivo del rango autorizado por la
    // DIAN es un recurso escaso. Validamos ANTES de incrementar el contador; si
    // falta, se aborta sin consumir número.
    if (!resolucion?.claveTecnica) {
      throw new BadRequestException(
        'No se puede emitir: falta la clave técnica DIAN de la sede para calcular el CUFE.',
      );
    }

    // La vigencia también se comprueba antes de tocar nada. Una resolución
    // vencida no autoriza a facturar, y sin esto el sistema seguía emitiendo
    // con normalidad e imprimiendo en cada factura una vigencia ya expirada.
    this.assertResolucionVigente(resolucion, 'invoice');

    // FEV con datos del cliente: si falta algo, se rechaza aquí, antes de
    // cobrar cupo o reservar folio, diciendo qué completar en la ficha.
    const validacion = validarAdquirienteParaFactura(sale.customer);
    if (!validacion.esConsumidorFinal && validacion.faltantes.length > 0) {
      throw new BadRequestException(
        `No se puede emitir la factura: en la ficha del cliente falta ${validacion.faltantes.join(', ')}.`,
      );
    }

    // Líneas con su tributo real, domicilio como línea, propina como cargo y
    // cuadre al centavo; todo antes del folio (si no cuadra, no se gasta).
    const doc = await this.armarDocumento(sale, sede);
    const nitOfe = this.nitParaCodigo(sede.nit);
    const emisorFiscal = await this.emisores.obtenerPorSede(sedeId);
    const tipoAmbiente = this.ambienteDe(emisorFiscal);

    const prefix = resolucion.prefijo ?? '';
    const adquiriente = this.buildAdquiriente(sale);
    const emisor = this.buildEmisor(sede);
    const medioPago = MEDIO_PAGO_BY_METHOD[sale.payment.method] ?? '10';

    return this.emitir({
      counterId: contadorDeResolucion('invoice', sedeId, prefix),
      desde: resolucion.rangoDesde ?? 1,
      hasta: resolucion.rangoHasta,
      prefix,
      nit: emisor.nit,
      existente: () =>
        this.model.findOne({ saleId: sale._id, type: 'invoice' }).exec(),
      exclusion: MENSAJE_EXCLUSION_POS_FEV.invoice,
      construir: (number) => {
        const fullNumber = `${prefix}${number}`;
        const { issueDate, issueTime } = this.now();
        // CUFE (anexo FEV 1.9 §11.1.2). La clave técnica ya se validó arriba.
        const cufe = calcularCufe({
          numero: fullNumber,
          fecha: issueDate,
          hora: issueTime,
          ...doc.codigoUnico,
          nitEmisor: nitOfe,
          numAdquiriente: this.numeroAdquiriente(adquiriente),
          claveTecnica: resolucion.claveTecnica as string,
          tipoAmbiente,
        });
        return {
          type: 'invoice',
          saleId: sale._id,
          ventaFiscal: sale._id,
          sedeId: new Types.ObjectId(sedeId),
          prefix: prefix || undefined,
          number,
          fullNumber,
          issueDate,
          issueTime,
          emisor,
          adquiriente,
          lines: doc.lines,
          charges: doc.charges.length ? doc.charges : undefined,
          ...doc.totales,
          discountTotal: sale.discountTotal ?? 0,
          total: doc.totales.payableAmount,
          // '2' crédito si la venta se fió (toda o en parte); '1' contado.
          formaPago: hasCreditPart(sale) ? '2' : '1',
          medioPago,
          resolution: this.buildResolution(resolucion),
          tipoAmbiente,
          aviso: doc.aviso,
          cufe,
          qrUrl: dianVerificationUrl(cufe, tipoAmbiente),
          dianStatus: 'draft',
          createdByEmail: user.email,
        };
      },
    });
  }

  /**
   * Documento equivalente electrónico POS de una venta (PR 7B; anexo DE v1.0).
   *
   * Mismo orden de garantías que la factura: todo lo que puede fallar se
   * valida ANTES de cobrar el cupo y reservar el folio (resolución `pos`
   * vigente, PIN del software, adquiriente del modo identificado, cuadre del
   * documento, NIT). Cupo y folio los toma `emitir`, que los devuelve si la
   * inserción falla.
   *
   * - Idempotente por venta+tipo: un doble clic devuelve el POS ya emitido.
   * - Excluyente con la FEV (D1): si la venta ya tiene factura, 409.
   * - El CUDE (§14.1.3) va con el PIN, no con la clave técnica, y no incluye
   *   el `InvoiceTypeCode`: si el documento termina en contingencia 08 se
   *   refirma con el mismo número y el mismo CUDE (D5).
   * - Fecha y hora se toman UNA vez, antes del folio: un reintento por choque
   *   de número no cambia la fecha del documento.
   * - Solo crea el documento en `draft`; la transmisión es aparte.
   */
  async createPosFromSale(
    saleId: string,
    modo: ModoPos,
    user: JwtUser,
  ): Promise<ElectronicDocumentDocument> {
    const sale = await this.sales.getOrFail(saleId);
    const sedeId = this.saleSedeId(sale);
    assertSedeAccess(user, sedeId);
    if (sale.status === 'void') {
      throw new BadRequestException(
        'No se puede emitir el documento POS de una venta anulada.',
      );
    }

    const existing = await this.documentoFiscalDeVenta(sale._id, 'pos');
    if (existing) return existing;

    const sede = await this.sedes.findOrFail(sedeId);
    const resolucion = resolucionDeTipo(sede, 'pos');
    if (!resolucion) {
      throw new BadRequestException(
        'No se puede emitir el documento POS: la sede no tiene resolución de numeración del documento equivalente POS.',
      );
    }
    this.assertResolucionVigente(resolucion, 'pos');

    const { adquiriente, faltantes } = adquirientePos(sale.customer, modo);
    if (!adquiriente) {
      throw new BadRequestException(
        `No se puede emitir el POS con datos del cliente: falta ${faltantes.join(', ')}.`,
      );
    }

    const doc = await this.armarDocumento(sale, sede);
    const nitOfe = this.nitParaCodigo(sede.nit);
    const emisorFiscal = await this.emisores.obtenerPorSede(sedeId);
    const tipoAmbiente = this.ambienteDe(emisorFiscal);
    // El PIN se descifra en cada emisión (no se guarda un secreto en memoria
    // de una función serverless): una lectura y un AES-GCM, acotado.
    const pin = emisorFiscal
      ? await this.emisores.leerSecreto(emisorFiscal.id as string, 'facturaPin')
      : null;
    if (!pin) throw new BadRequestException(MENSAJE_POS_SIN_PIN);

    const prefix = resolucion.prefijo ?? '';
    const emisor = this.buildEmisor(sede);
    const cajaVenta = cajaVentaPos(sede, sale);
    const fabricante = fabricanteDesdeEntorno(process.env);
    const pagos = pagosPos(sale);
    const { issueDate, issueTime } = this.now();

    return this.emitir({
      counterId: contadorDeResolucion('pos', sedeId, prefix),
      desde: resolucion.rangoDesde ?? 1,
      hasta: resolucion.rangoHasta,
      prefix,
      nit: emisor.nit,
      existente: () => this.model.findOne({ saleId: sale._id, type: 'pos' }).exec(),
      exclusion: MENSAJE_EXCLUSION_POS_FEV.pos,
      construir: (number) => {
        const fullNumber = `${prefix}${number}`;
        const cude = calcularCudePos({
          numero: fullNumber,
          fecha: issueDate,
          hora: issueTime,
          ...doc.codigoUnico,
          nitEmisor: nitOfe,
          numAdquiriente: this.numeroAdquiriente(adquiriente),
          softwarePin: pin,
          tipoAmbiente,
        });
        return {
          type: 'pos',
          saleId: sale._id,
          ventaFiscal: sale._id,
          sedeId: new Types.ObjectId(sedeId),
          prefix: prefix || undefined,
          number,
          fullNumber,
          issueDate,
          issueTime,
          emisor,
          adquiriente,
          lines: doc.lines,
          charges: doc.charges.length ? doc.charges : undefined,
          ...doc.totales,
          discountTotal: sale.discountTotal ?? 0,
          total: doc.totales.payableAmount,
          formaPago: hasCreditPart(sale) ? '2' : '1',
          medioPago: MEDIO_PAGO_BY_METHOD[sale.payment.method] ?? '10',
          pagos,
          cajaVenta,
          fabricante,
          resolution: this.buildResolution(resolucion),
          tipoAmbiente,
          aviso: doc.aviso,
          cufe: cude,
          qrUrl: dianVerificationUrl(cude, tipoAmbiente),
          dianStatus: 'draft',
          createdByEmail: user.email,
        };
      },
    });
  }

  /**
   * El documento fiscal (POS o FEV) que ya tiene la venta. Si es del tipo
   * pedido se devuelve (idempotencia); si es del otro, 409 (D1). Cubre también
   * las facturas anteriores a la Fase 7, que no tienen `ventaFiscal` y por eso
   * no entran al índice de exclusión.
   */
  private async documentoFiscalDeVenta(
    saleId: Types.ObjectId,
    tipo: 'pos' | 'invoice',
  ): Promise<ElectronicDocumentDocument | null> {
    const previo = await this.model
      .findOne({ saleId, type: { $in: [...TIPOS_EXCLUYENTES_POR_VENTA] } })
      .exec();
    if (!previo) return null;
    if (previo.type === tipo) return previo;
    throw new ConflictException(MENSAJE_EXCLUSION_POS_FEV[tipo]);
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

    // Resolución propia de nota crédito si la sede la tiene registrada. Si no,
    // se conserva el comportamiento de siempre: numeración libre `NC<n>` (contador
    // `nc:<sede>`, sin rango ni vigencia). La clave técnica ya no se pide: el
    // CUDE va con el PIN del software (ver abajo).
    const resolucionNota = resolucionDeTipo(sede, 'credit_note');
    if (resolucionNota) {
      this.assertResolucionVigente(resolucionNota, 'credit_note');
    }

    const prefix = resolucionNota ? (resolucionNota.prefijo ?? '') : 'NC';
    // El emisor se congela con la factura; las facturas viejas no traen
    // `nitNorm`, así que se calcula aquí para que la nota entre al índice.
    const emisorFactura = this.plano(invoice.emisor);
    const nitFactura = emisorFactura?.nit as string | undefined;
    const emisor = { ...emisorFactura, nitNorm: normalizarNit(nitFactura) };
    const nitOfe = this.nitParaCodigo(nitFactura ?? sede.nit);

    // La nota lleva CUDE, con el PIN del software del emisor (anexo FEV 1.9
    // §11.1.4), nunca con la clave técnica de la resolución. Sin PIN no se
    // emite: igual que la factura sin clave técnica, se rechaza antes de
    // cobrar cupo o gastar folio.
    const emisorFiscal = await this.emisores.obtenerPorSede(sedeId);
    const tipoAmbiente = this.ambienteDe(emisorFiscal);
    const pin = emisorFiscal
      ? await this.emisores.leerSecreto(emisorFiscal.id as string, 'facturaPin')
      : null;
    if (!pin) throw new BadRequestException(MENSAJE_NOTA_SIN_PIN);

    // Una nota crédito también es un documento electrónico: cuenta al cupo
    // (dentro de `emitir`, antes de quemar folio).
    return this.emitir({
      counterId: resolucionNota
        ? contadorDeResolucion('credit_note', sedeId, prefix)
        : `nc:${sedeId}`,
      desde: resolucionNota?.rangoDesde ?? 1,
      hasta: resolucionNota?.rangoHasta,
      prefix,
      nit: nitFactura,
      existente: () =>
        this.model.findOne({ saleId: invoice.saleId, type: 'credit_note' }).exec(),
      construir: (number) => {
        const fullNumber = `${prefix}${number}`;
        const { issueDate, issueTime } = this.now();
        // Los valores son los de la factura tal como se guardó: un documento
        // viejo no se recalcula (su INC, si lo tenía, quedó en `ivaTotal`).
        // `aCentavos` conserva los centavos que traiga una factura vieja.
        const cude = calcularCude({
          numero: fullNumber,
          fecha: issueDate,
          hora: issueTime,
          valorBruto: aCentavos(invoice.taxableBase ?? 0),
          impuestos: {
            '01': aCentavos(invoice.ivaTotal ?? 0),
            '04': aCentavos(invoice.incTotal ?? 0),
            '03': aCentavos(invoice.icaTotal ?? 0),
          },
          valorTotal: aCentavos(invoice.payableAmount ?? invoice.total),
          nitEmisor: nitOfe,
          numAdquiriente: this.numeroAdquiriente(invoice.adquiriente),
          softwarePin: pin,
          tipoAmbiente,
        });
        return {
          type: 'credit_note',
          saleId: invoice.saleId,
          sedeId: invoice.sedeId,
          prefix: prefix || undefined,
          number,
          fullNumber,
          issueDate,
          issueTime,
          emisor,
          adquiriente: invoice.adquiriente,
          lines: invoice.lines,
          charges: invoice.charges,
          taxableBase: invoice.taxableBase,
          taxExclusiveAmount: invoice.taxExclusiveAmount,
          ivaTotal: invoice.ivaTotal,
          incTotal: invoice.incTotal,
          icaTotal: invoice.icaTotal,
          bagTaxTotal: invoice.bagTaxTotal,
          taxInclusiveAmount: invoice.taxInclusiveAmount,
          chargeTotal: invoice.chargeTotal,
          payableAmount: invoice.payableAmount,
          discountTotal: invoice.discountTotal,
          total: invoice.total,
          formaPago: invoice.formaPago,
          medioPago: invoice.medioPago,
          resolution: resolucionNota
            ? this.buildResolution(resolucionNota)
            : invoice.resolution,
          reason,
          referenceNumber: invoice.fullNumber,
          referenceCufe: invoice.cufe,
          referenceId: invoice._id,
          tipoAmbiente,
          cufe: cude,
          qrUrl: dianVerificationUrl(cude, tipoAmbiente),
          dianStatus: 'draft',
          createdByEmail: user.email,
        };
      },
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
  private assertResolucionVigente(
    r: ResolucionFe | undefined,
    tipo: TipoResolucion,
  ): void {
    const hoy = new Date();
    // La factura conserva el mensaje de siempre; los demás nombran el tipo.
    const de = tipo === 'invoice' ? '' : ` de ${NOMBRE_TIPO_RESOLUCION[tipo]}`;
    if (r?.vigenciaHasta && new Date(r.vigenciaHasta) < startOfDay(hoy)) {
      throw new BadRequestException(
        `La resolución de numeración${de} de esta sede está vencida. Renuévala ante la DIAN antes de seguir facturando.`,
      );
    }
    if (r?.vigenciaDesde && new Date(r.vigenciaDesde) > endOfDay(hoy)) {
      throw new BadRequestException(
        `La vigencia de la resolución de numeración${de} de esta sede todavía no ha empezado.`,
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
    // La clave técnica NO viaja: solo si está puesta, dentro del estado.
    const vista = (r: ResolucionFe): ResolucionVista => ({
      numero: r.numero,
      fechaResolucion: r.fechaResolucion,
      prefijo: r.prefijo,
      rangoDesde: r.rangoDesde,
      rangoHasta: r.rangoHasta,
      vigenciaDesde: r.vigenciaDesde,
      vigenciaHasta: r.vigenciaHasta,
    });
    return Promise.all(
      sedes.map(async (sede) => {
        const sedeId = sede.id as string;
        const r = resolucionDeTipo(sede, 'invoice');
        const siguiente = r
          ? await this.peekNumber('invoice', sedeId, r.prefijo, r.rangoDesde)
          : undefined;
        const otras = await Promise.all(
          (sede.resolucionesFe ?? []).map(async (o) => {
            const tipo = o.tipoDocumento ?? TIPO_RESOLUCION_POR_DEFECTO;
            const sig = await this.peekNumber(tipo, sedeId, o.prefijo, o.rangoDesde);
            return {
              tipoDocumento: tipo,
              resolucion: vista(o),
              status: computeResolutionStatus(o, sig),
            };
          }),
        );
        return {
          sedeId,
          sedeCode: sede.code,
          sedeName: sede.name,
          tipoDocumento: 'invoice' as const,
          resolucion: r ? vista(r) : undefined,
          status: computeResolutionStatus(r, siguiente),
          otras,
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
    const tipo = dto.tipoDocumento ?? TIPO_RESOLUCION_POR_DEFECTO;
    const previa = resolucionDeTipo(sede, tipo);

    const prefijo = dto.prefijo?.toUpperCase() ?? '';
    // El consecutivo se comparte por (NIT, prefijo) entre todos los tipos: sin
    // prefijo propio, un POS o una nota chocarían con la factura.
    if (tipo !== 'invoice' && !prefijo) {
      throw new BadRequestException(
        `La resolución de ${NOMBRE_TIPO_RESOLUCION[tipo]} necesita un prefijo propio, distinto al de la factura.`,
      );
    }

    const desde = dto.rangoDesde ?? 1;
    // Nunca arrancar en un número ya emitido para (NIT, prefijo), sea cual sea
    // el tipo: la DIAN rechaza la repetición y el índice único también.
    const mayor = await this.mayorNumeroEmitido(sede.nit, prefijo);
    if (dto.empezarEn != null && dto.empezarEn <= mayor) {
      throw new BadRequestException(
        `El número inicial ${dto.empezarEn} ya fue emitido con el prefijo ${prefijo || '(sin prefijo)'}: el último fue el ${mayor}. Empieza en ${mayor + 1} o más.`,
      );
    }
    const empezarEn = dto.empezarEn ?? Math.max(desde, mayor + 1);
    if (empezarEn < desde || (dto.rangoHasta != null && empezarEn > dto.rangoHasta)) {
      throw new BadRequestException(
        'El número inicial tiene que estar dentro del rango autorizado.',
      );
    }

    const nueva = {
      tipoDocumento: tipo,
      numero: dto.numero,
      fechaResolucion: dto.fechaResolucion
        ? new Date(dto.fechaResolucion)
        : undefined,
      prefijo: prefijo || undefined,
      rangoDesde: desde,
      rangoHasta: dto.rangoHasta,
      vigenciaDesde: dto.vigenciaDesde ? new Date(dto.vigenciaDesde) : undefined,
      vigenciaHasta: dto.vigenciaHasta ? new Date(dto.vigenciaHasta) : undefined,
      // La clave técnica se conserva si no viene una nueva: es un dato que se
      // teclea una vez y perderlo dejaría la sede sin poder emitir.
      claveTecnica: dto.claveTecnica ?? previa?.claveTecnica,
    };
    if (tipo === 'invoice') {
      sede.resolucionFe = nueva;
    } else {
      // Una por tipo: la nueva reemplaza a la del mismo tipo.
      sede.resolucionesFe = [
        ...(sede.resolucionesFe ?? []).filter((r) => r.tipoDocumento !== tipo),
        nueva,
      ];
    }
    await sede.save();

    await this.counters
      .findOneAndUpdate(
        { _id: contadorDeResolucion(tipo, sedeId, nueva.prefijo) },
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
    tipo: TipoResolucion,
    sedeId: string,
    prefijo: string | undefined,
    rangoDesde: number | undefined,
  ): Promise<number> {
    const counter = await this.counters
      .findById(contadorDeResolucion(tipo, sedeId, prefijo))
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

  /**
   * Sigue leyendo la sede aunque ya exista `fiscal_emitters` (Fase 1), a
   * propósito: la pantalla de sedes es la única que edita estos datos y el
   * emisor aún no se sincroniza con ella. Leer el emisor aquí haría que un
   * cambio de razón social o de DV en la sede dejara de llegar a la factura sin
   * avisar. Pasa al emisor cuando su pantalla de configuración sea la fuente.
   */
  private buildEmisor(sede: SedeDocument) {
    return {
      name: sede.businessName || sede.name,
      nit: sede.nit,
      // NIT base normalizado: es la llave del índice `consecutivo_unico`.
      nitNorm: normalizarNit(sede.nit),
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

  /** Adquiriente según lo capturado del cliente; ver `domain/adquiriente.ts`. */
  private buildAdquiriente(sale: SaleDocument) {
    return buildAdquiriente(sale.customer);
  }

  private buildResolution(r: ResolucionFe | undefined) {
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
