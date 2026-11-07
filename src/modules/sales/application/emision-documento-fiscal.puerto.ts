import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import type { DocumentoFiscalSolicitado } from '../domain/documento-fiscal';

/**
 * Puerto con el que el cobro pide el documento fiscal de la venta.
 *
 * Lo implementa el módulo de factura electrónica (`EinvoicingModule`), que ya
 * importa `SalesModule`: inyectarlo directo cerraría un ciclo entre módulos.
 * Por eso ventas lo resuelve en tiempo de ejecución con `ModuleRef` y este
 * token, sin importar nada de `einvoicing`.
 */
export const EMISION_DOCUMENTO_FISCAL = 'EMISION_DOCUMENTO_FISCAL';

export interface DocumentoFiscalEmitido {
  documentoId: string;
  tipo: 'pos' | 'invoice';
  fullNumber: string;
  cude?: string;
  qrUrl?: string;
  dianStatus: string;
}

export interface EmisionDocumentoFiscal {
  /**
   * Emite (o devuelve, si ya existe) el documento de la venta. Lanza las
   * excepciones HTTP del emisor (400 faltan datos, 409 exclusión POS/FEV…).
   */
  emitir(
    saleId: string,
    solicitado: DocumentoFiscalSolicitado,
    user: JwtUser,
  ): Promise<DocumentoFiscalEmitido>;

  /** Transmite el documento a la DIAN. Nunca lanza: un fallo lo deja para la reconsulta. */
  transmitir(documentoId: string, user: JwtUser): Promise<void>;
}

/** Talonario de contingencia: número impreso (sin prefijo) y fecha AAAA-MM-DD. */
export interface TalonarioContingencia {
  numero: number;
  fecha: string;
}

/**
 * Contingencia del facturador (Fase 9): transcribe la venta hecha sin BookiPos
 * (POS 07 / FEV 03) y transmite el documento con sus notas en orden.
 */
export interface TranscripcionContingencia {
  /** Lanza las excepciones HTTP del emisor (400 faltan datos o numeración, 409…). */
  transcribirContingencia(
    saleId: string,
    solicitado: DocumentoFiscalSolicitado,
    opts: { talonario?: TalonarioContingencia },
    user: JwtUser,
  ): Promise<DocumentoFiscalEmitido>;
  /** Documento y después sus notas. Nunca lanza. */
  transmitirContingencia(documentoId: string, user: JwtUser): Promise<void>;
}

/** Concepto de corrección de la nota crédito (DiscrepancyResponse). */
export type ConceptoNota = '1' | '2' | '3' | '4' | '5' | '6';

/** Una línea devuelta que la nota acredita: los valores del plan de la devolución. */
export interface LineaNotaSolicitada {
  productId: string;
  qty: number;
  /** Lo devuelto por la línea, con impuesto. */
  valor: number;
  /** Impuesto incluido en `valor`. */
  impuesto: number;
}

/**
 * Nota crédito (FEV, 91) o de ajuste crédito (POS, 94) que pide una operación
 * de venta (Fase 6B). `origen` es la llave idempotente de la operación.
 */
export interface SolicitudNotaVenta {
  saleId: string;
  origen: string;
  /**
   * 1 devolución parcial, 2 anulación; 3 rebaja, 4 ajuste de precio, 5 pronto
   * pago y 6 volumen (Fase 6C: sin unidades, `qty` 0; 5 y 6 solo en la FEV).
   */
  concepto: ConceptoNota;
  motivo: string;
  /** Solo en la devolución. */
  lineas?: LineaNotaSolicitada[];
  /**
   * Propina que vuelve con la devolución (decisión 4): la nota la acredita
   * como cargo de documento, hasta la propina facturada menos la ya acreditada.
   */
  propina?: number;
}

/** Lo que quedó del documento fiscal de la operación (se guarda en la devolución o en la venta). */
export interface NotaFiscalOperacion {
  /**
   * - `emitida`: la nota existe con número y CUDE; se transmite detrás.
   * - `sin_nota`: la venta no tiene documento fiscal válido ante la DIAN
   *   (no se pidió, fue rechazado o el POS está pendiente de contingencia):
   *   no lleva nota. También una devolución sin valor (no hay qué acreditar).
   */
  estado: 'emitida' | 'sin_nota';
  documentoId?: string;
  fullNumber?: string;
  cude?: string;
  /** `type` del documento referido: `pos` → nota de ajuste 94; `invoice` → nota crédito 91. */
  referenceType?: 'pos' | 'invoice';
  referenceNumber?: string;
  concepto?: ConceptoNota;
  dianStatus?: string;
  /** Por qué no lleva nota, en lenguaje de la caja. */
  motivo?: string;
}

/** Puerto de las notas (lo implementa el mismo adaptador de `EMISION_DOCUMENTO_FISCAL`). */
export interface EmisionNotaVenta {
  /**
   * Emite (o devuelve, si la operación ya la tiene) la nota. FALLA CERRADO:
   * sin PIN, sin resolución vigente o por encima del tope lanza la excepción
   * HTTP y quien llama no mueve nada.
   */
  emitirNota(s: SolicitudNotaVenta, user: JwtUser): Promise<NotaFiscalOperacion>;
  /** Transmite a la DIAN. Nunca lanza: un fallo lo deja para la reconsulta. */
  transmitir(documentoId: string, user: JwtUser): Promise<void>;
}

/**
 * Nota crédito SIN referencia (FEV, CustomizationID 22; Fase 6C): descuento
 * que cubre las facturas de un cliente en un periodo de máximo 30 días dentro
 * de un mismo mes. El tope y el reparto por tributo los hace facturación.
 */
export interface SolicitudNotaSinReferencia {
  origen: string;
  sedeId: string;
  /** Documento del adquiriente (cédula o NIT, sin DV) de las facturas del periodo. */
  docNumber: string;
  concepto: Exclude<ConceptoNota, '1' | '2'>;
  motivo: string;
  desde: string;
  hasta: string;
  /** Monto con impuesto. */
  monto: number;
}

/** La nota sin referencia emitida, con lo que lleva al libro. */
export interface NotaSinReferenciaEmitida extends NotaFiscalOperacion {
  estado: 'emitida';
  documentoId: string;
  /** Lo acreditado, con impuesto (= `monto`). */
  total: number;
  iva: number;
  inc: number;
  /**
   * Cómo se repartió entre las ventas del periodo, por producto (`productId`
   * es el grupo del documento: producto o `domicilio`). Las devoluciones y
   * rebajas de esas ventas lo descuentan (tope cruzado).
   */
  asignaciones: { saleId: string; productId: string; valor: number; impuesto: number }[];
}

/** Puerto de la nota sin referencia (lo implementa el mismo adaptador). */
export interface EmisionNotaSinReferencia {
  /** FALLA CERRADO: 400 sin facturas en el periodo, 409 por encima del tope. */
  emitirNotaSinReferencia(s: SolicitudNotaSinReferencia, user: JwtUser): Promise<NotaSinReferenciaEmitida>;
  transmitir(documentoId: string, user: JwtUser): Promise<void>;
}
