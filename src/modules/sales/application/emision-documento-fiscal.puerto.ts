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
  /** 1 devolución parcial, 2 anulación. */
  concepto: '1' | '2';
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
  concepto?: '1' | '2';
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
