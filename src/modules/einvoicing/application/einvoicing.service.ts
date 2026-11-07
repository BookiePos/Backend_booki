import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
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
import {
  CONCEPTOS_SIN_CANTIDAD,
  CONCEPTOS_SOLO_FEV,
  asignacionComoPrevia,
  repartoSinReferencia,
  saldoAcreditable,
  type AsignacionSinReferencia,
  type SaldoGrupo,
  type UnidadSinReferencia,
  gruposDelDocumento,
  cargosDeDevolucion,
  lineasDeAnulacion,
  lineasDeDevolucion,
  NotaNoRelacionableError,
  TopeNotaExcedidoError,
  totalesDeNota,
  type LineaPrevia,
  type LineaReferida,
} from '../domain/nota-de-venta';
import type { CargoDocumento, LineaDocumento } from '../domain/documento-venta';
import { totalesUbl } from '../domain/ubl/factura-ubl';
import { CONCEPTOS_NOTA_CREDITO, esquemaDeOrigen } from '../domain/ubl/nota-ubl';
import {
  corteTalonarioValido,
  errorTalonario,
  subrangosContingencia,
  tipoContingencia,
  type TipoContingencia,
} from '../domain/contingencia';

/** Contador de la serie automática de contingencia (ventas sin conexión), aparte del de la resolución. */
export const contadorContingenciaAutomatica = (sedeId: string, prefijo: string): string =>
  `fe:contingency-auto:${sedeId}:${prefijo}`;
import { cop } from '../../finance/domain/money.util';
import { origenNotaAnulacion } from '../../sales/domain/documento-fiscal';
import type {
  SolicitudNotaSinReferencia,
  SolicitudNotaVenta,
} from '../../sales/application/emision-documento-fiscal.puerto';
import { hasCreditPart } from '../../sales/domain/sale-payments';
import { causesInc } from '../../core-tax/domain/sale-tax';
import type { BusinessType } from '../../control/domain/control.constants';
import {
  TIPO_AMBIENTE_POR_DEFECTO,
  type TipoAmbiente,
} from '../domain/emisor-fiscal';
import { FiscalEmittersService } from './fiscal-emitters.service';
import { AuditService } from '../../core-audit/application/audit.service';
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

/** Prefijo de la nota crédito de la FEV sin resolución propia (§6 del estudio de la Fase 6). */
export const PREFIJO_NOTA_CREDITO = 'NC';
/** Prefijo de la nota de ajuste crédito del POS: distinto del de la NC para que el número nunca choque. */
export const PREFIJO_AJUSTE_POS = 'NAC';

/** La venta no tiene documento fiscal: la operación sigue sin nota. */
export const MENSAJE_SIN_DOCUMENTO_FISCAL =
  'La venta no tiene documento electrónico (POS ni factura): la operación no lleva nota ante la DIAN.';

/** El documento fue rechazado: no existe ante la DIAN y no lleva nota. */
export const MENSAJE_REFERIDO_RECHAZADO = (numero: string) =>
  `El documento ${numero} fue rechazado por la DIAN: no existe ante ella y no lleva nota.`;

/** Conceptos que acepta la nota de una operación de venta (Fase 6B y 6C). */
const CONCEPTOS_NOTA_VENTA: readonly string[] = ['1', '2', '3', '4', '5', '6'];

/** La nota de ajuste del POS no tiene los descuentos comerciales 5 y 6 (anexo DE §16.6). */
export const MENSAJE_CONCEPTO_SOLO_FEV = (numero: string) =>
  `${numero} es un documento POS: su nota de ajuste no tiene los descuentos comerciales 5 y 6 (son de la factura electrónica). Registra la rebaja con el concepto 3.`;

/** La nota sin referencia es solo de la FEV (Concepto DIAN 61 de 2025: el POS siempre lleva referencia). */
export const MENSAJE_SIN_REFERENCIA_SIN_FACTURAS =
  'El cliente no tiene facturas electrónicas válidas en ese periodo y sede: la nota sin referencia solo cubre facturas (un POS siempre se corrige con su nota de ajuste referida).';

/** Lo que devuelve `emitirNotaDeVenta`. */
export type ResultadoNotaDeVenta =
  | { estado: 'emitida'; nota: ElectronicDocumentDocument }
  | { estado: 'sin_nota'; motivo: string };

/** Rechazo de la nota cuando el emisor no tiene PIN: sin él no hay CUDE. */
export const MENSAJE_NOTA_SIN_PIN =
  'Carga el PIN del software DIAN del emisor antes de emitir notas.';

/** Sin la numeración de contingencia de la sede no se transcribe (Fase 9). */
export const MENSAJE_SIN_NUMERACION_CONTINGENCIA =
  'No se puede transcribir: la sede no tiene numeración de contingencia. Regístrala en Resoluciones con el tipo «Contingencia» (la autoriza la DIAN).';

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
  /** Solo la de contingencia: último número del talonario de papel (el corte guardado). */
  corteTalonario?: number;
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
  /** Solo contingencia: último número del talonario de papel (por defecto, la mitad del rango). */
  corteTalonario?: number;
}

/** Inicio y fin del día, para comparar vigencias sin que la hora estorbe. */
const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/** El XML de la DIAN (base64, hasta ~1 MB) lo lee la entrega; la API no lo devuelve. */
const SIN_APPLICATION_RESPONSE = '-respuestaDian.applicationResponse';

/**
 * Campos internos que `GET /einvoicing` y `GET /einvoicing/:id` no devuelven:
 * rutas del bucket (XML firmado, PDF, AttachedDocument, XML original de
 * contingencia) y la URL del XML. Las descargas salen por URL firmada de vida
 * corta (`DocumentoFeVistaService`); la pantalla no lee ninguno.
 */
export const CAMPOS_INTERNOS_DOCUMENTO = ['xmlPath', 'pdfPath', 'attachedPath', 'xmlUrl'] as const;

/** Copia plana del documento sin rutas internas (ni `contingencia.xmlOriginalPath`). */
export function sinCamposInternos(doc: ElectronicDocumentDocument): Record<string, unknown> {
  const plano = (
    typeof doc.toObject === 'function' ? doc.toObject() : { ...doc }
  ) as Record<string, unknown>;
  for (const campo of CAMPOS_INTERNOS_DOCUMENTO) delete plano[campo];
  const c = plano.contingencia;
  if (c && typeof c === 'object') {
    const { xmlOriginalPath: _ruta, ...resto } = c as Record<string, unknown>;
    plano.contingencia = resto;
  }
  return plano;
}

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
    /** Auditoría de negocio (emisión, resolución). Opcional solo para los tests antiguos. */
    private readonly audit?: AuditService,
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
    /** Quién emite: queda en la fila de auditoría de la emisión. */
    actor: JwtUser;
    /**
     * Número ya impreso (talonario de contingencia, Fase 9): no toma folio del
     * contador. Si el número ya existe, 409 con `choqueNumeroFijo`.
     */
    numeroFijo?: number;
    choqueNumeroFijo?: string;
  }): Promise<ElectronicDocumentDocument> {
    const MAX_INTENTOS = 3;
    for (let intento = 1; ; intento++) {
      // Cupo del plan antes de quemar folio: si no hay cupo, 402 sin consumir nada.
      const origen = await this.consumeDocQuota();
      let number: number | undefined;
      let creado: ElectronicDocumentDocument | undefined;
      try {
        number = o.numeroFijo ?? (await this.nextNumber(o.counterId, o.desde, o.hasta));
        creado = await this.model.create(o.construir(number));
      } catch (err) {
        await this.refundDocQuota(origen);
        const choque = tipoDeChoque(err);
        if (o.numeroFijo !== undefined) {
          if (choque === 'venta' || choque === 'exclusion') {
            const existente = await o.existente();
            if (existente) return existente;
          }
          if (choque === 'consecutivo' || choque === 'exclusion') {
            throw new ConflictException(o.choqueNumeroFijo ?? o.exclusion ?? 'Ese número ya existe.');
          }
          throw err;
        }
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
      // Fuera del try: si la auditoría lanzara, el catch devolvería cupo y folio
      // de un documento que YA existe.
      await this.auditarEmision(creado, o.actor);
      return creado;
    }
  }

  /**
   * Una fila por documento fiscal emitido (FEV, POS o nota): quién, qué número
   * y su CUFE/CUDE. Solo ids y códigos: nunca el XML, la clave ni el PIN. Es
   * aparte de la fila HTTP del interceptor, que no sabe el número.
   */
  private async auditarEmision(doc: ElectronicDocumentDocument, user: JwtUser): Promise<void> {
    await this.audit?.record({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      method: 'POST',
      path: `/einvoicing/documentos/${String(doc._id)}/emision`,
      statusCode: 201,
      success: true,
      action: 'einvoicing.documento.emitido',
      detail: {
        documentoId: String(doc._id),
        tipo: String(doc.type),
        fullNumber: String(doc.fullNumber),
        cufe: String(doc.cufe ?? ''),
        sedeId: String(doc.sedeId),
        tipoAmbiente: String(doc.tipoAmbiente ?? ''),
      },
    });
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
  async list(sedeId: string, user: JwtUser): Promise<Record<string, unknown>[]> {
    assertSedeAccess(user, sedeId);
    const docs = await this.model
      .find({ sedeId: new Types.ObjectId(sedeId) })
      .select(SIN_APPLICATION_RESPONSE)
      .sort({ createdAt: -1 })
      .limit(200)
      .exec();
    return docs.map(sinCamposInternos);
  }

  async get(id: string, user: JwtUser): Promise<Record<string, unknown>> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).select(SIN_APPLICATION_RESPONSE).exec()
      : null;
    if (!doc) throw new NotFoundException('Documento no encontrado');
    assertSedeAccess(user, doc.sedeId.toString());
    return sinCamposInternos(doc);
  }

  /**
   * De los documentos dados, los de contingencia, con cuántas de sus notas
   * siguen sin aceptar la DIAN. Un documento normal no aparece. Solo lectura;
   * los ids vienen de ventas que quien llama ya puede ver.
   */
  async notasPorTransmitirDeContingencia(documentoIds: string[]): Promise<Record<string, number>> {
    const ids = documentoIds.filter((i) => Types.ObjectId.isValid(i)).slice(0, 200);
    const out: Record<string, number> = {};
    if (ids.length === 0) return out;
    const docs = (await this.model
      .find({ _id: { $in: ids }, 'contingencia.tipo': { $exists: true } })
      .select({ _id: 1 })
      .lean()
      .exec()) as unknown as { _id: unknown }[];
    for (const d of docs) out[String(d._id)] = 0;
    const claves = Object.keys(out);
    if (claves.length === 0) return out;
    const notas = (await this.model
      .find({
        type: { $in: ['credit_note', 'debit_note'] },
        referenceId: { $in: claves },
        dianStatus: { $ne: 'accepted' },
      })
      .select({ referenceId: 1 })
      .lean()
      .exec()) as unknown as { referenceId?: unknown }[];
    for (const n of notas) {
      const k = String(n.referenceId);
      if (k in out) out[k]! += 1;
    }
    return out;
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
      actor: user,
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
      actor: user,
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
   * Transcripción de contingencia del FACTURADOR (Fase 9): la venta se hizo sin
   * BookiPos (sin conexión o en talonario) y, superada la falla, se expide su
   * documento electrónico: POS 07 o FEV 03 (anexo DE §15; anexo FEV §12.1).
   *
   * - Numeración de CONTINGENCIA de la sede (resolución `contingency`): el
   *   rango se parte en dos series ascendentes (`subrangosContingencia`): el
   *   talonario de papel, de `desde` al corte (`corteTalonario`, por defecto la
   *   mitad), con su número impreso; y las ventas sin conexión, del corte + 1 a
   *   `hasta`, con su propio contador. Un papel fuera de su serie es 400; una
   *   serie agotada, 409. Un papel ya entregado nunca choca con el sistema.
   * - Fecha: con talonario, la del PAPEL (`talonario.fecha`, con su hora o la
   *   de la venta), la misma del `AdditionalDocumentReference`; sin talonario,
   *   la real de la venta (`soldAt`; si no, `createdAt`).
   * - CUDE con el PIN, también en la FEV 03 (§11.1.4.2 nota 2).
   * - Plazo de 48 h desde que se superó la falla: `superadaAt` si lo dice quien
   *   transcribe (ni futuro ni anterior a la venta); si no, para la venta sin
   *   conexión, cuando llegó al servidor (`createdAt`), y para el talonario, ahora.
   * - Una venta anulada después también se transcribe: el documento es el de la
   *   venta tal como se hizo; su nota de anulación la emite quien llama, en orden.
   * - Mismo fallar cerrado que la emisión normal: todo se valida ANTES del
   *   cupo y del folio. Idempotente por venta: devuelve el ya transcrito; si la
   *   venta tiene un documento normal, 409.
   */
  async transcribirContingencia(
    saleId: string,
    solicitado: { tipo: 'pos' | 'invoice'; modo?: ModoPos },
    opts: { talonario?: { numero: number; fecha: string; hora?: string }; superadaAt?: Date },
    user: JwtUser,
  ): Promise<ElectronicDocumentDocument> {
    const sale = await this.sales.getOrFail(saleId);
    const sedeId = this.saleSedeId(sale);
    assertSedeAccess(user, sedeId);

    const previo = await this.model
      .findOne({ saleId: sale._id, type: { $in: [...TIPOS_EXCLUYENTES_POR_VENTA] } })
      .exec();
    if (previo) {
      if (previo.type === solicitado.tipo && previo.contingencia?.tipo) return previo;
      throw new ConflictException('La venta ya tiene su documento electrónico: no se transcribe en contingencia.');
    }

    const tipo = tipoContingencia(solicitado.tipo, 'facturador') as TipoContingencia;
    const sede = await this.sedes.findOrFail(sedeId);
    const resolucion = resolucionDeTipo(sede, 'contingency');
    if (!resolucion) {
      throw new BadRequestException(MENSAJE_SIN_NUMERACION_CONTINGENCIA);
    }
    this.assertResolucionVigente(resolucion, 'contingency');
    const prefix = resolucion.prefijo ?? '';
    const series = subrangosContingencia(resolucion);
    if (!series) {
      throw new BadRequestException(
        'La numeración de contingencia de la sede necesita un rango con inicio y fin, y un corte del talonario dentro de él.',
      );
    }

    const momentoVenta = sale.soldAt ?? (sale as { createdAt?: Date }).createdAt ?? new Date();
    const deLaVenta = this.now(momentoVenta);
    const hoy = this.now().issueDate;
    const talonario = opts.talonario;
    if (talonario) {
      const t = series.talonario;
      if (talonario.numero < t.desde || talonario.numero > t.hasta) {
        throw new BadRequestException(
          `El número ${prefix}${talonario.numero} no está en la serie del talonario de papel (${prefix}${t.desde} a ${prefix}${t.hasta}); ` +
            `del ${prefix}${series.automatico.desde} al ${prefix}${series.automatico.hasta} son las ventas sin conexión.`,
        );
      }
      const error = errorTalonario(
        { numero: talonario.numero, fecha: talonario.fecha, hoy },
        { ...resolucion, rangoDesde: t.desde, rangoHasta: t.hasta },
      );
      if (error) throw new BadRequestException(error);
      if (talonario.hora !== undefined && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(talonario.hora)) {
        throw new BadRequestException('La hora del talonario va en formato HH:MM o HH:MM:SS.');
      }
    }
    // Con talonario manda el PAPEL (checklist Fase 9: «la fecha real del
    // talonario»; a confirmar con el contador): su fecha y su hora, o la hora
    // de la venta si el papel no la trae.
    const issueDate = talonario?.fecha ?? deLaVenta.issueDate;
    const issueTime = talonario?.hora
      ? `${talonario.hora.length === 5 ? `${talonario.hora}:00` : talonario.hora}-05:00`
      : deLaVenta.issueTime;

    const ahora = new Date();
    // Con talonario, la venta «ocurrió» en la fecha y hora del papel.
    const momentoOrigen = talonario ? new Date(`${issueDate}T${issueTime}`) : momentoVenta;
    if (opts.superadaAt) {
      if (Number.isNaN(opts.superadaAt.getTime()) || opts.superadaAt > ahora) {
        throw new BadRequestException('La fecha en que se superó la falla no puede ser futura.');
      }
      if (opts.superadaAt < momentoOrigen) {
        throw new BadRequestException('La fecha en que se superó la falla no puede ser anterior a la venta.');
      }
    }

    let adquiriente: ReturnType<typeof buildAdquiriente>;
    if (solicitado.tipo === 'pos') {
      const r = adquirientePos(sale.customer, solicitado.modo ?? 'anonimo');
      if (!r.adquiriente) {
        throw new BadRequestException(`No se puede transcribir el POS con datos del cliente: falta ${r.faltantes.join(', ')}.`);
      }
      adquiriente = r.adquiriente;
    } else {
      const validacion = validarAdquirienteParaFactura(sale.customer);
      if (!validacion.esConsumidorFinal && validacion.faltantes.length > 0) {
        throw new BadRequestException(
          `No se puede transcribir la factura: en la ficha del cliente falta ${validacion.faltantes.join(', ')}.`,
        );
      }
      adquiriente = this.buildAdquiriente(sale);
    }

    const doc = await this.armarDocumento(sale, sede);
    const nitOfe = this.nitParaCodigo(sede.nit);
    const emisorFiscal = await this.emisores.obtenerPorSede(sedeId);
    const tipoAmbiente = this.ambienteDe(emisorFiscal);
    const pin = emisorFiscal ? await this.emisores.leerSecreto(emisorFiscal.id as string, 'facturaPin') : null;
    if (!pin) throw new BadRequestException(MENSAJE_POS_SIN_PIN.replace('el documento POS', 'el documento de contingencia'));

    const emisor = this.buildEmisor(sede);
    const superadaAt = opts.superadaAt ?? (talonario ? ahora : ((sale as { createdAt?: Date }).createdAt ?? ahora));
    const camposPos =
      solicitado.tipo === 'pos'
        ? { pagos: pagosPos(sale), cajaVenta: cajaVentaPos(sede, sale), fabricante: fabricanteDesdeEntorno(process.env) }
        : {};

    return this.emitir({
      actor: user,
      counterId: contadorContingenciaAutomatica(sedeId, prefix),
      // La serie automática: del corte + 1 al final del rango. Agotada, 409.
      desde: series.automatico.desde,
      hasta: series.automatico.hasta,
      prefix,
      nit: emisor.nit,
      numeroFijo: talonario?.numero,
      choqueNumeroFijo: `El número ${prefix}${talonario?.numero ?? ''} del talonario ya fue transcrito.`,
      existente: () => this.model.findOne({ saleId: sale._id, type: solicitado.tipo }).exec(),
      exclusion: MENSAJE_EXCLUSION_POS_FEV[solicitado.tipo],
      construir: (number) => {
        const fullNumber = `${prefix}${number}`;
        const cude = calcularCude({
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
          type: solicitado.tipo,
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
          ...camposPos,
          resolution: this.buildResolution(resolucion),
          tipoAmbiente,
          aviso: doc.aviso,
          cufe: cude,
          qrUrl: dianVerificationUrl(cude, tipoAmbiente),
          dianStatus: 'draft',
          contingencia: {
            tipo,
            declaradaAt: ahora,
            superadaAt,
            // El talonario: su número impreso. La venta sin conexión: su consecutivo de BookiPos.
            referencia: { id: talonario ? fullNumber : sale.saleNumber, fecha: talonario?.fecha ?? issueDate },
          },
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

  /**
   * Anula la factura o el POS con su nota (concepto 2). Desde la Fase 6B ya no
   * emite una nota suelta: anula la VENTA (`SalesService.void`), que reversa
   * stock, caja, fiado y libro y emite la nota en la misma operación. Antes la
   * DIAN veía la factura anulada y el libro conservaba el ingreso y el IVA/INC.
   *
   * Si la venta ya estaba anulada (anulaciones anteriores a la Fase 6B, que no
   * emitían documento), solo falta el documento: se emite la nota sin tocar el
   * libro, que ya se reversó.
   */
  async createCreditNote(
    documentoId: string,
    reason: string,
    user: JwtUser,
  ): Promise<ElectronicDocumentDocument> {
    const doc = await this.getOrFail(documentoId);
    assertSedeAccess(user, doc.sedeId.toString());
    if (doc.type !== 'invoice' && doc.type !== 'pos') {
      throw new BadRequestException('Solo se anula una factura de venta o un documento POS');
    }
    if (!doc.saleId) {
      throw new BadRequestException('El documento no está ligado a una venta: no se puede anular desde aquí.');
    }
    if (doc.dianStatus === 'rejected') {
      throw new BadRequestException(MENSAJE_REFERIDO_RECHAZADO(doc.fullNumber));
    }
    const saleId = doc.saleId.toString();
    // Todo lo que impide la nota se revisa ANTES de anular la venta.
    const referido = await this.documentoReferido(doc.saleId);
    if (!referido || String(referido._id) !== String(doc._id)) {
      throw new ConflictException('Ese documento ya no es el documento fiscal vigente de la venta.');
    }
    const origen = origenNotaAnulacion(saleId);
    const sale = await this.sales.getOrFail(saleId);
    if (sale.status !== 'void') {
      // Anular la venta es más que emitir la nota: exige el mismo permiso que
      // la anulación desde la caja, para que `einvoicing.void` no la salte.
      if (!user.permissions?.includes(PERMISSIONS.POS_VOID_AUTHORIZE)) {
        throw new ForbiddenException('Anular la venta exige el permiso de autorizar anulaciones del POS.');
      }
      await this.sales.void(saleId, user, { motivo: reason });
    } else {
      const r = await this.emitirNotaDeVenta({ saleId, origen, concepto: '2', motivo: reason }, user);
      if (r.estado !== 'emitida') throw new BadRequestException(r.motivo);
      return r.nota;
    }
    const nota = await this.model.findOne({ origenNota: origen }).select(SIN_APPLICATION_RESPONSE).exec();
    if (!nota) {
      throw new ConflictException('La venta se anuló pero su nota no quedó registrada: revísalo en el detalle de la venta.');
    }
    return nota;
  }

  /**
   * Documento fiscal vigente de la venta: el que tiene la llave de exclusión
   * (`ventaFiscal`, Fase 7) o, en las facturas anteriores, el `invoice`/`pos`
   * con su `saleId`.
   */
  private async documentoReferido(saleId: Types.ObjectId): Promise<ElectronicDocumentDocument | null> {
    const vigente = await this.model.findOne({ ventaFiscal: saleId }).exec();
    if (vigente) return vigente;
    return this.model
      .findOne({ saleId, type: { $in: [...TIPOS_EXCLUYENTES_POR_VENTA] } })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Nota crédito (FEV → 91) o nota de ajuste crédito (POS → 94) de una
   * devolución (concepto 1) o de una anulación (concepto 2) de la venta
   * (Fase 6B, `documentacion/fe-fase6-notas.md` §2, §4 y §5).
   *
   * - Idempotente por OPERACIÓN (`origen`): el reintento devuelve la misma nota.
   *   Una nota rechazada por la DIAN libera la llave y se emite otra.
   * - `referenceType` sale SIEMPRE del `type` del documento referido.
   * - Tope en el servidor (`nota-de-venta.ts`): por grupo y con cantidad, base,
   *   IVA e INC por separado, contra las notas previas no rechazadas. 409.
   * - Falla cerrado: tope, PIN, resolución y NIT se revisan ANTES de cobrar
   *   cupo o tomar folio. Quien llama no mueve stock, caja ni libro si esto lanza.
   * - Sin documento fiscal (o rechazado) no hay nota: `sin_nota` con el motivo.
   * - CUDE con los valores DE LA NOTA y el PIN (§2.3). Solo crea la nota en
   *   `draft`: la transmisión va aparte y detrás de la respuesta.
   */
  async emitirNotaDeVenta(
    s: SolicitudNotaVenta,
    user: JwtUser,
  ): Promise<ResultadoNotaDeVenta> {
    if (!s.origen?.trim()) throw new BadRequestException('La nota necesita la operación que la origina');
    if (!CONCEPTOS_NOTA_VENTA.includes(s.concepto)) {
      throw new BadRequestException('Concepto de la nota no admitido: 1 devolución, 2 anulación o 3 a 6 rebajas y descuentos');
    }
    const sinCantidad = CONCEPTOS_SIN_CANTIDAD.includes(s.concepto);
    if (!s.motivo?.trim()) throw new BadRequestException('La nota necesita el motivo');
    const sale = await this.sales.getOrFail(s.saleId);
    const sedeId = this.saleSedeId(sale);
    assertSedeAccess(user, sedeId);

    const previaMisma = await this.model.findOne({ origenNota: s.origen }).exec();
    if (previaMisma && previaMisma.dianStatus !== 'rejected') {
      return { estado: 'emitida', nota: previaMisma };
    }
    if (previaMisma) {
      // La DIAN rechazó la nota de esta operación: queda como historia y su
      // llave se libera para la nota que la reemplaza.
      await this.model
        .updateOne(
          { _id: previaMisma._id, dianStatus: 'rejected', origenNota: s.origen },
          { $set: { origenNota: `${s.origen}#rechazada:${String(previaMisma._id)}` } },
        )
        .exec();
    }

    const referido = await this.documentoReferido(sale._id);
    if (!referido) {
      return { estado: 'sin_nota', motivo: MENSAJE_SIN_DOCUMENTO_FISCAL };
    }
    if (referido.dianStatus === 'rejected') {
      return { estado: 'sin_nota', motivo: MENSAJE_REFERIDO_RECHAZADO(referido.fullNumber) };
    }
    const referenceType: 'pos' | 'invoice' = referido.type === 'pos' ? 'pos' : 'invoice';
    if (referenceType === 'pos' && CONCEPTOS_SOLO_FEV.includes(s.concepto)) {
      // Anexo DE §16.6: la nota de ajuste del POS tiene 1–4 y 5 «Otros»; los
      // descuentos comerciales 5 y 6 son de la NC de la FEV (tabla 13.2.4).
      throw new BadRequestException(MENSAJE_CONCEPTO_SOLO_FEV(referido.fullNumber));
    }
    if (!referido.cufe || !referido.issueDate) {
      throw new ConflictException(`El documento ${referido.fullNumber} no tiene CUFE/CUDE o fecha: no se puede referenciar.`);
    }

    const previas = await this.model
      .find({
        type: 'credit_note',
        dianStatus: { $ne: 'rejected' },
        // Tope cruzado (Fase 6C): también lo que una nota sin referencia le asignó.
        $or: [{ referenceId: referido._id }, { 'asignaciones.referenceId': referido._id }],
      })
      .exec();
    // Una nota de antes de la Fase 6B (sin `refKey`) ya anuló el documento
    // entero ante la DIAN sin tocar el libro: es justo el hueco que deja la
    // venta con ingreso e IVA/INC vivos. Anular la venta ahora la reutiliza
    // como su nota de anulación en vez de emitir otra.
    const legado = previas.find(
      (p) =>
        !(p.asignaciones ?? []).length &&
        ((p.lines ?? []).length === 0 || (p.lines ?? []).some((l) => !this.plano(l)?.refKey)),
    );
    if (s.concepto === '2' && legado) {
      return { estado: 'emitida', nota: legado };
    }
    const lineasPrevias = previas.map((p) => this.lineasPreviasDe(p, referido._id));
    let lineas: LineaReferida[];
    let cargos: CargoDocumento[];
    try {
      const referidas = gruposDelDocumento(
        (referido.lines ?? []).map((l) => this.plano(l) as unknown as LineaDocumento),
        sale.lines.map((l) => l.productId.toString()),
        cop(sale.deliveryFee ?? 0) > 0,
      );
      if (s.concepto === '2') {
        ({ lineas, cargos } = lineasDeAnulacion(
          referidas,
          (referido.charges ?? []).map((c) => this.plano(c) as unknown as CargoDocumento),
          lineasPrevias,
        ));
      } else if (sinCantidad) {
        // Rebaja o descuento (Fase 6C): valor sin unidades y sin propina.
        lineas = lineasDeDevolucion(
          referidas,
          lineasPrevias,
          (s.lineas ?? []).map((l) => ({
            refKey: l.productId,
            qty: 0,
            valor: cop(l.valor),
            impuesto: cop(l.impuesto),
          })),
          { sinCantidad: true },
        );
        cargos = [];
      } else {
        lineas = lineasDeDevolucion(
          referidas,
          lineasPrevias,
          (s.lineas ?? []).map((l) => ({
            refKey: l.productId,
            qty: l.qty,
            valor: cop(l.valor),
            impuesto: cop(l.impuesto),
          })),
        );
        // La propina devuelta (decisión 4) viaja como cargo, topada contra la
        // facturada menos la que acreditaron las notas previas.
        cargos = cargosDeDevolucion(
          (referido.charges ?? []).map((c) => this.plano(c) as unknown as CargoDocumento),
          previas.map((p) => (p.charges ?? []).map((c) => this.plano(c) as unknown as CargoDocumento)),
          cop(s.propina ?? 0),
        );
      }
    } catch (err) {
      if (err instanceof TopeNotaExcedidoError || err instanceof NotaNoRelacionableError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
    const totales = totalesDeNota(lineas, cargos);
    if (totales.payableAmount <= 0) {
      return { estado: 'sin_nota', motivo: 'Lo devuelto no tiene valor: no hay nada que acreditar ante la DIAN.' };
    }
    return this.emitirNota({
      user,
      sedeId,
      origen: s.origen,
      concepto: s.concepto,
      motivo: s.motivo,
      referido,
      lineas,
      cargos,
      notaDeVenta: sale._id,
    });
  }

  /**
   * Numera, calcula el CUDE y guarda la nota crédito en `draft`: lo común a la
   * nota de una operación de venta (con referencia) y a la nota sin referencia
   * (Fase 6C). Falla cerrado: PIN, resolución y NIT antes de tomar folio.
   */
  private async emitirNota(o: {
    user: JwtUser;
    sedeId: string;
    origen: string;
    concepto: string;
    motivo: string;
    /** El documento que corrige; en la nota sin referencia, la última factura del periodo (solo da emisor y adquiriente). */
    referido: ElectronicDocumentDocument;
    sinReferencia?: { desde: string; hasta: string };
    lineas: LineaReferida[];
    cargos: CargoDocumento[];
    notaDeVenta?: Types.ObjectId;
    /** Nota sin referencia: su reparto entre las facturas del periodo. */
    asignaciones?: { referenceId: Types.ObjectId; saleId?: Types.ObjectId; refKey: string; taxScheme?: string; taxRate: number; base: number; taxAmount: number }[];
  }): Promise<ResultadoNotaDeVenta & { estado: 'emitida' }> {
    const { user, sedeId, referido, lineas, cargos } = o;
    const s = { origen: o.origen, concepto: o.concepto, motivo: o.motivo };
    const totales = totalesDeNota(lineas, cargos);
    const referenceType: 'pos' | 'invoice' = referido.type === 'pos' ? 'pos' : 'invoice';
    const sede = await this.sedes.findOrFail(sedeId);
    // Numeración (§6): consecutivo interno, sin resolución obligatoria. La FEV
    // usa la resolución `credit_note` si la sede la registró; si no, `NC<n>`.
    // El POS lleva su prefijo propio `NAC<n>` para no chocar con la NC.
    const resolucionNota = referenceType === 'invoice' ? resolucionDeTipo(sede, 'credit_note') : undefined;
    if (resolucionNota) this.assertResolucionVigente(resolucionNota, 'credit_note');
    const prefix = resolucionNota
      ? (resolucionNota.prefijo ?? '')
      : referenceType === 'pos'
        ? PREFIJO_AJUSTE_POS
        : PREFIJO_NOTA_CREDITO;
    const counterId = resolucionNota
      ? contadorDeResolucion('credit_note', sedeId, prefix)
      : `${referenceType === 'pos' ? 'nac' : 'nc'}:${sedeId}`;

    // El emisor se congela con el documento referido; los viejos no traen `nitNorm`.
    const emisorReferido = this.plano(referido.emisor);
    const nitReferido = emisorReferido?.nit as string | undefined;
    const emisor = { ...emisorReferido, nitNorm: normalizarNit(nitReferido) };
    const nitOfe = this.nitParaCodigo(nitReferido ?? sede.nit);

    const emisorFiscal = await this.emisores.obtenerPorSede(sedeId);
    const tipoAmbiente = this.ambienteDe(emisorFiscal);
    const pin = emisorFiscal
      ? await this.emisores.leerSecreto(emisorFiscal.id as string, 'facturaPin')
      : null;
    if (!pin) throw new BadRequestException(MENSAJE_NOTA_SIN_PIN);

    // Fecha y hora UNA vez: un reintento por choque de número no las cambia.
    const { issueDate, issueTime } = this.now();
    const valores = totalesUbl(lineas, cargos);
    const numAdquiriente = this.numeroAdquiriente(this.plano(referido.adquiriente) as { docType?: string; docNumber?: string });
    const existente = () => this.model.findOne({ origenNota: s.origen }).exec();
    try {
      const nota = await this.emitir({
        actor: user,
        counterId,
        desde: resolucionNota?.rangoDesde ?? 1,
        hasta: resolucionNota?.rangoHasta,
        prefix,
        nit: nitReferido,
        existente,
        construir: (number) => {
          const fullNumber = `${prefix}${number}`;
          const cude = calcularCude({
            numero: fullNumber,
            fecha: issueDate,
            hora: issueTime,
            valorBruto: valores.lineExtension,
            impuestos: { '01': valores.iva, '04': valores.inc, '03': 0 },
            valorTotal: valores.payable,
            nitEmisor: nitOfe,
            numAdquiriente,
            softwarePin: pin,
            tipoAmbiente,
          });
          // Sin referencia (Fase 6C, CustomizationID 22): sin BillingReference y con el periodo.
          const referencia = o.sinReferencia
            ? { period: o.sinReferencia, asignaciones: o.asignaciones }
            : {
                referenceNumber: referido.fullNumber,
                referenceCufe: referido.cufe,
                referenceId: referido._id,
                referenceIssueDate: referido.issueDate,
                referenceType,
                referenceScheme: esquemaDeOrigen(referenceType === 'pos' ? 'pos' : 'factura'),
              };
          return {
            type: 'credit_note',
            // Sin `saleId`: el índice `saleId_1_type_1` permitiría una sola nota por venta.
            notaDeVenta: o.notaDeVenta,
            origenNota: s.origen,
            sedeId: referido.sedeId,
            prefix: prefix || undefined,
            number,
            fullNumber,
            issueDate,
            issueTime,
            emisor,
            adquiriente: referido.adquiriente,
            lines: lineas,
            charges: cargos.length ? cargos : undefined,
            ...totales,
            discountTotal: 0,
            total: totales.payableAmount,
            formaPago: referido.formaPago,
            medioPago: referido.medioPago,
            resolution: resolucionNota ? this.buildResolution(resolucionNota) : undefined,
            reason: s.motivo.trim(),
            discrepancyCode: s.concepto,
            ...referencia,
            tipoAmbiente,
            cufe: cude,
            qrUrl: dianVerificationUrl(cude, tipoAmbiente),
            dianStatus: 'draft',
            createdByEmail: user.email,
          };
        },
      });
      return { estado: 'emitida', nota };
    } catch (err) {
      // Si la nota alcanzó a guardarse (falló algo después, p. ej. la
      // auditoría), la operación la tiene: no se emite otra en el reintento.
      const yaGuardada = await existente().catch(() => null);
      if (yaGuardada) return { estado: 'emitida', nota: yaGuardada };
      throw err;
    }
  }

  /**
   * Nota crédito SIN referencia de la FEV (Fase 6C; CustomizationID 22, art. 36
   * par. 1 Res. 165/2023): el descuento por volumen o por pronto pago que
   * cubre las facturas de un cliente en un periodo de máximo 30 días dentro de
   * un mismo mes (`InvoicePeriod`). Nunca el concepto 2 (CBF03a) y nunca un
   * POS (Concepto DIAN 61 de 2025: la nota de ajuste siempre lleva referencia).
   *
   * - Idempotente por `origen`, como la nota de una operación.
   * - Tope por tributo (IVA, INC, sin impuesto) contra lo facturado al cliente
   *   en el periodo menos las notas con referencia a esas facturas y las notas
   *   sin referencia previas del cliente en ese mes (`saldoPorTributo`). 409.
   * - Emisor y adquiriente: los de la última factura del periodo.
   */
  async emitirNotaSinReferencia(
    s: SolicitudNotaSinReferencia,
    user: JwtUser,
  ): Promise<ElectronicDocumentDocument> {
    if (!s.origen?.trim()) throw new BadRequestException('La nota necesita la operación que la origina');
    if (!['3', '4', '5', '6'].includes(s.concepto)) {
      throw new BadRequestException('La nota sin referencia admite los conceptos 3 a 6 (nunca la anulación).');
    }
    if (!s.motivo?.trim()) throw new BadRequestException('La nota necesita el motivo');
    if (!s.docNumber?.trim()) throw new BadRequestException('El cliente no tiene documento de identificación.');
    assertSedeAccess(user, s.sedeId);
    const fecha = /^\d{4}-\d{2}-\d{2}$/;
    if (!fecha.test(s.desde) || !fecha.test(s.hasta) || s.desde > s.hasta) {
      throw new BadRequestException('El periodo de la nota no es válido (AAAA-MM-DD, inicio antes del fin).');
    }
    const dias = (Date.parse(`${s.hasta}T00:00:00Z`) - Date.parse(`${s.desde}T00:00:00Z`)) / 86_400_000 + 1;
    if (dias > 30 || s.desde.slice(0, 7) !== s.hasta.slice(0, 7)) {
      throw new BadRequestException('El periodo de la nota sin referencia es de máximo 30 días y dentro de un mismo mes.');
    }
    const monto = cop(s.monto);

    const previa = await this.model.findOne({ origenNota: s.origen }).exec();
    if (previa && previa.dianStatus !== 'rejected') return previa;
    if (previa) {
      await this.model
        .updateOne(
          { _id: previa._id, dianStatus: 'rejected', origenNota: s.origen },
          { $set: { origenNota: `${s.origen}#rechazada:${String(previa._id)}` } },
        )
        .exec();
    }

    const sedeOid = new Types.ObjectId(s.sedeId);
    const docNumber = s.docNumber.trim();
    // El documento puede haberse congelado con o sin puntos y guion (NIT con DV aparte).
    const docs = [...new Set([docNumber, docNumber.replace(/\D/g, '')].filter(Boolean))];
    const facturas = await this.model
      .find({
        type: 'invoice',
        sedeId: sedeOid,
        'adquiriente.docNumber': { $in: docs },
        issueDate: { $gte: s.desde, $lte: s.hasta },
        dianStatus: { $ne: 'rejected' },
      })
      .sort({ issueDate: -1, createdAt: -1 })
      .exec();
    if (facturas.length === 0) throw new BadRequestException(MENSAJE_SIN_REFERENCIA_SIN_FACTURAS);
    // Unidades del reparto: lo que queda de cada producto (y del domicilio) de
    // cada factura, descontando sus notas con referencia y lo que ya le
    // asignaron notas sin referencia previas (tope cruzado).
    const unidades: UnidadSinReferencia[] = [];
    try {
      for (const f of facturas) {
        if (!f.saleId) continue;
        const venta = await this.sales.getOrFail(f.saleId.toString());
        const referidas = gruposDelDocumento(
          (f.lines ?? []).map((l) => this.plano(l) as unknown as LineaDocumento),
          venta.lines.map((l) => l.productId.toString()),
          cop(venta.deliveryFee ?? 0) > 0,
        );
        let saldo: Map<string, SaldoGrupo>;
        try {
          saldo = saldoAcreditable(referidas, await this.previasDe(f._id));
        } catch (err) {
          // Ya anulada por una nota por el total (anterior a la 6B): no le queda nada.
          if (err instanceof TopeNotaExcedidoError) continue;
          throw err;
        }
        for (const r of referidas) {
          const g = saldo.get(r.refKey);
          if (!g || unidades.some((u) => u.referenceId === String(f._id) && u.refKey === r.refKey)) continue;
          const scheme = r.taxScheme === '01' || r.taxScheme === '04' ? r.taxScheme : undefined;
          const impuesto = Math.max(g.iva + g.inc, 0);
          const valor = Math.max(g.base, 0) + impuesto;
          unidades.push({
            referenceId: String(f._id),
            saleId: f.saleId.toString(),
            refKey: r.refKey,
            taxScheme: scheme,
            taxRate: scheme ? (r.taxRate ?? 0) : 0,
            valor,
            impuesto: Math.min(impuesto, valor),
          });
        }
      }
    } catch (err) {
      if (err instanceof NotaNoRelacionableError) throw new ConflictException(err.message);
      throw err;
    }
    let reparto: ReturnType<typeof repartoSinReferencia>;
    try {
      reparto = repartoSinReferencia(unidades, monto, CONCEPTOS_NOTA_CREDITO[s.concepto] ?? 'Descuento');
    } catch (err) {
      if (err instanceof TopeNotaExcedidoError || err instanceof NotaNoRelacionableError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
    const r = await this.emitirNota({
      user,
      sedeId: s.sedeId,
      origen: s.origen,
      concepto: s.concepto,
      motivo: s.motivo,
      referido: facturas[0]!,
      sinReferencia: { desde: s.desde, hasta: s.hasta },
      lineas: reparto.lineas,
      cargos: [],
      asignaciones: reparto.asignaciones.map((a) => ({
        ...a,
        referenceId: new Types.ObjectId(a.referenceId),
        saleId: a.saleId ? new Types.ObjectId(a.saleId) : undefined,
      })),
    });
    return r.nota;
  }

  /**
   * Lo que ya acreditaron otras notas a una factura: sus notas con referencia
   * (líneas con `refKey`) y la parte que le asignaron las notas sin
   * referencia (Fase 6C, tope cruzado). No rechazadas.
   */
  private async previasDe(facturaId: Types.ObjectId): Promise<LineaPrevia[][]> {
    const notas = await this.model
      .find({
        type: 'credit_note',
        dianStatus: { $ne: 'rejected' },
        $or: [{ referenceId: facturaId }, { 'asignaciones.referenceId': facturaId }],
      })
      .exec();
    return notas.map((p) => this.lineasPreviasDe(p, facturaId));
  }

  /** Las líneas de una nota que cuentan contra una factura. */
  private lineasPreviasDe(p: ElectronicDocumentDocument, facturaId: Types.ObjectId): LineaPrevia[] {
    // Una nota con referencia cuenta por sus líneas; una sin referencia, por
    // la parte que le asignó a esta factura.
    if (!(p.asignaciones ?? []).length) {
      return (p.lines ?? []).map((l) => this.plano(l) as unknown as LineaPrevia);
    }
    return (p.asignaciones ?? [])
      .map((a) => this.plano(a) as unknown as AsignacionSinReferencia & { referenceId: unknown })
      .filter((a) => String(a.referenceId) === String(facturaId))
      .map(asignacionComoPrevia);
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
      ...(r.corteTalonario != null ? { corteTalonario: r.corteTalonario } : {}),
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

    // Sin vigencia final no se puede saber cuándo deja de servir, y una vencida
    // no sirve para emitir: ninguna se registra, venga de la DIAN o tecleada.
    if (!dto.vigenciaHasta) {
      throw new BadRequestException('La resolución necesita la fecha de vigencia final (vigenciaHasta).');
    }
    // Se compara como texto YYYY-MM-DD contra el día de hoy en Colombia: con
    // `new Date('YYYY-MM-DD')` (UTC) una resolución salía vencida en su último día.
    const hoyColombia = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    if (String(dto.vigenciaHasta).slice(0, 10) < hoyColombia) {
      throw new BadRequestException('La resolución ya venció: no se puede registrar una vigencia pasada.');
    }

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

    if (dto.corteTalonario != null && tipo !== 'contingency') {
      throw new BadRequestException('El corte del talonario solo aplica a la numeración de contingencia.');
    }
    // El corte se conserva si no viene uno nuevo, como la clave técnica: volver
    // a la mitad en silencio dejaría números de papel ya impresos dentro de la
    // serie automática, y una venta sin conexión podría tomar uno de ellos
    // (número repetido ante la DIAN al transcribir el papel).
    const corteHeredado = dto.corteTalonario == null && tipo === 'contingency' ? previa?.corteTalonario : undefined;
    const corteTalonario = tipo === 'contingency' ? (dto.corteTalonario ?? corteHeredado) : undefined;
    if (corteTalonario != null && !corteTalonarioValido(desde, dto.rangoHasta, corteTalonario)) {
      throw new BadRequestException(
        corteHeredado != null
          ? `El corte del talonario guardado (${corteHeredado}) no cabe en el rango nuevo: envía corteTalonario con el corte que corresponde a los talonarios impresos.`
          : 'El corte del talonario tiene que estar dentro del rango y dejar al menos un número para las ventas sin conexión.',
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
      ...(corteTalonario != null ? { corteTalonario } : {}),
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
    if (tipo === 'contingency') {
      // La serie automática arranca en su inicio (corte + 1); si ya hay
      // números emitidos, el choque del índice sube el contador al mayor.
      await this.counters
        .findOneAndUpdate(
          { _id: contadorContingenciaAutomatica(sedeId, nueva.prefijo ?? '') },
          { $set: { seq: 0 } },
          { upsert: true },
        )
        .exec();
    }

    // Sin clave técnica en el detalle: solo qué se registró y desde qué número.
    await this.audit?.record({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      method: 'POST',
      path: `/einvoicing/resolutions/${sedeId}`,
      statusCode: 201,
      success: true,
      action: previa ? 'einvoicing.resolucion.renovada' : 'einvoicing.resolucion.registrada',
      detail: {
        sedeId,
        tipoDocumento: tipo,
        numero: String(nueva.numero ?? ''),
        prefijo: nueva.prefijo ?? '',
        rangoDesde: String(desde),
        rangoHasta: String(nueva.rangoHasta ?? ''),
        vigenciaHasta: String(dto.vigenciaHasta).slice(0, 10),
        empezarEn: String(empezarEn),
        claveTecnicaNueva: String(dto.claveTecnica != null),
      },
    });

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

  /** Fecha/hora en zona Colombia (UTC-5, sin DST); por defecto, ahora. */
  private now(en: Date = new Date()): { issueDate: string; issueTime: string } {
    const shifted = new Date(en.getTime() - 5 * 3600 * 1000).toISOString();
    return {
      issueDate: shifted.slice(0, 10),
      issueTime: `${shifted.slice(11, 19)}-05:00`,
    };
  }
}
