/**
 * Documento fiscal que pide la caja al cobrar (Fase 7, D1 del anexo POS).
 *
 * La caja tiene tres salidas, excluyentes entre sí por venta:
 * - `pos_anonimo`: documento equivalente POS a consumidor final (por defecto
 *   en el Frontend 7C);
 * - `pos_identificado`: POS con nombre y documento del cliente;
 * - `fev`: factura electrónica de venta, con la ficha fiscal completa.
 *
 * Si el cobro no lo pide, no se emite nada: es el comportamiento de antes y el
 * de los negocios que todavía no tienen emisor ni resolución POS.
 *
 * Dominio puro: sin Nest ni Mongoose.
 */
export const DOCUMENTOS_FISCALES = [
  'pos_anonimo',
  'pos_identificado',
  'fev',
] as const;
export type DocumentoFiscalSolicitado = (typeof DOCUMENTOS_FISCALES)[number];

/**
 * Cómo quedó el documento fiscal de la venta (no es el estado DIAN, que vive
 * en `electronic_documents.dianStatus`):
 * - `emitido`: el documento existe con su número, CUDE/CUFE y QR (en `draft`
 *   hasta que se transmita); el tiquete ya se puede imprimir.
 * - `en_proceso`: la emisión no terminó dentro del plazo del cobro y sigue en
 *   segundo plano; el detalle de la venta lo mostrará al terminar.
 * - `error`: no se pudo emitir (sin resolución, sin PIN, faltan datos del
 *   cliente, la venta ya tiene el otro documento…). La venta queda cobrada.
 * - `pendiente_contingencia_07`: venta hecha sin conexión; el navegador no
 *   tiene el PIN y no puede calcular el CUDE. Se transcribe en la Fase 9.
 */
export const ESTADOS_DOCUMENTO_FISCAL = [
  'emitido',
  'en_proceso',
  'error',
  'pendiente_contingencia_07',
] as const;
export type EstadoDocumentoFiscal = (typeof ESTADOS_DOCUMENTO_FISCAL)[number];

/** Lo que se guarda en la venta y viaja en la respuesta del cobro. */
export interface DocumentoFiscalVenta {
  solicitado: DocumentoFiscalSolicitado;
  estado: EstadoDocumentoFiscal;
  /** `_id` del documento en `electronic_documents`. */
  documentoId?: string;
  tipo?: 'pos' | 'invoice';
  fullNumber?: string;
  /** CUDE (POS) o CUFE (FEV). */
  cude?: string;
  qrUrl?: string;
  dianStatus?: string;
  /** Por qué no se emitió, en lenguaje de la caja. */
  error?: string;
}

/** Modo del POS que corresponde a lo solicitado (la FEV no tiene modo). */
export function modoPosDe(
  solicitado: DocumentoFiscalSolicitado,
): 'anonimo' | 'identificado' | undefined {
  if (solicitado === 'pos_anonimo') return 'anonimo';
  if (solicitado === 'pos_identificado') return 'identificado';
  return undefined;
}
