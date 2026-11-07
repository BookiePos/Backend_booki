import type { ElectronicDocumentDocument } from '../infrastructure/schemas/electronic-document.schema';

/**
 * Puerto de la entrega al adquiriente (Fase 5B): representación gráfica (PDF)
 * y AttachedDocument firmado + ZIP de un documento ACEPTADO por la DIAN.
 *
 * `TransmisionDianService` lo llama justo después de guardar `accepted`. Un
 * fallo aquí NUNCA mueve el estado DIAN: queda en `entregaDian` y se puede
 * reintentar con `POST /einvoicing/documentos/:id/entrega`.
 */
export const ENTREGA_DIAN = Symbol('ENTREGA_DIAN');

export type EstadoEntrega =
  /** PDF y ZIP (AttachedDocument + PDF) guardados. */
  | 'completa'
  /** Solo el PDF: falta algo para el AttachedDocument (ver `motivo`). */
  | 'incompleta'
  /** Factura 04 entregada sin validación previa (PDF + XML 04); al aceptarse se rehace con el AttachedDocument. */
  | 'contingencia'
  /** Ya estaba completa y no se pidió regenerar. */
  | 'ya_entregada'
  /** No aplica (documento no aceptado o de un tipo sin entrega todavía). */
  | 'omitida';

export interface ResultadoEntrega {
  documentoId: string;
  estado: EstadoEntrega;
  motivo?: string;
  pdf: boolean;
  zip: boolean;
}

export interface OpcionesEntrega {
  /** Regenera aunque ya esté completa (mismas rutas: no duplica). */
  forzar?: boolean;
}

export interface EntregaDian {
  entregar(doc: ElectronicDocumentDocument, opciones?: OpcionesEntrega): Promise<ResultadoEntrega>;
  /**
   * Entrega de la factura 04 al declararla (Fase 9): PDF y XML 04 firmado, sin
   * ApplicationResponse. Idempotente: una sola vez por documento.
   */
  entregarContingencia?(doc: ElectronicDocumentDocument): Promise<ResultadoEntrega>;
}
