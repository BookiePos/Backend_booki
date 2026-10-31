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
