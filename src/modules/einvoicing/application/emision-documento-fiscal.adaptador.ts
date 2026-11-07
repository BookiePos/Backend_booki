import { Injectable, Logger } from '@nestjs/common';
import { EinvoicingService } from './einvoicing.service';
import { TransmisionDianService } from './transmision-dian.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  modoPosDe,
  type DocumentoFiscalSolicitado,
} from '../../sales/domain/documento-fiscal';
import type {
  DocumentoFiscalEmitido,
  EmisionDocumentoFiscal,
  ConceptoNota,
  EmisionNotaSinReferencia,
  EmisionNotaVenta,
  NotaFiscalOperacion,
  NotaSinReferenciaEmitida,
  SolicitudNotaSinReferencia,
  SolicitudNotaVenta,
  OpcionesTranscripcion,
  TranscripcionContingencia,
} from '../../sales/application/emision-documento-fiscal.puerto';

const CONCEPTOS: readonly ConceptoNota[] = ['1', '2', '3', '4', '5', '6'];
/** El concepto guardado en la nota; uno desconocido se lee como devolución (1), como antes de la 6C. */
const conceptoDe = (codigo?: string): ConceptoNota =>
  CONCEPTOS.find((c) => c === codigo) ?? '1';

/**
 * Implementación del puerto `EMISION_DOCUMENTO_FISCAL` que usa el cobro
 * (ventas): POS anónimo, POS identificado o FEV, sobre `EinvoicingService`, y
 * la transmisión con `TransmisionDianService`.
 */
@Injectable()
export class EmisionDocumentoFiscalDian
  implements EmisionDocumentoFiscal, EmisionNotaVenta, EmisionNotaSinReferencia, TranscripcionContingencia
{
  private readonly logger = new Logger(EmisionDocumentoFiscalDian.name);

  constructor(
    private readonly einvoicing: EinvoicingService,
    private readonly transmision: TransmisionDianService,
  ) {}

  async emitir(
    saleId: string,
    solicitado: DocumentoFiscalSolicitado,
    user: JwtUser,
  ): Promise<DocumentoFiscalEmitido> {
    const modo = modoPosDe(solicitado);
    const doc = modo
      ? await this.einvoicing.createPosFromSale(saleId, modo, user)
      : await this.einvoicing.createFromSale(saleId, user);
    return {
      documentoId: String(doc._id),
      tipo: doc.type === 'pos' ? 'pos' : 'invoice',
      fullNumber: doc.fullNumber,
      cude: doc.cufe,
      qrUrl: doc.qrUrl,
      dianStatus: doc.dianStatus,
    };
  }

  /** Transcripción de contingencia 07/03 (Fase 9). Lanza: falla cerrado. */
  async transcribirContingencia(
    saleId: string,
    solicitado: DocumentoFiscalSolicitado,
    opts: OpcionesTranscripcion,
    user: JwtUser,
  ): Promise<DocumentoFiscalEmitido> {
    const modo = modoPosDe(solicitado);
    const doc = await this.einvoicing.transcribirContingencia(
      saleId,
      modo ? { tipo: 'pos', modo } : { tipo: 'invoice' },
      opts,
      user,
    );
    return {
      documentoId: String(doc._id),
      tipo: doc.type === 'pos' ? 'pos' : 'invoice',
      fullNumber: doc.fullNumber,
      cude: doc.cufe,
      qrUrl: doc.qrUrl,
      dianStatus: doc.dianStatus,
    };
  }

  /** Documento de contingencia y después sus notas, en orden. Nunca lanza. */
  async transmitirContingencia(documentoId: string, user: JwtUser): Promise<void> {
    try {
      await this.transmision.procesarContingencia(documentoId, user);
    } catch (err) {
      this.logger.warn(`Contingencia ${documentoId}: transmisión pendiente (${(err as Error)?.name ?? 'Error'}).`);
    }
  }

  /** Nota de una devolución o anulación (Fase 6B). Lanza: la operación falla cerrado. */
  async emitirNota(s: SolicitudNotaVenta, user: JwtUser): Promise<NotaFiscalOperacion> {
    const r = await this.einvoicing.emitirNotaDeVenta(s, user);
    if (r.estado === 'sin_nota') return { estado: 'sin_nota', motivo: r.motivo };
    const n = r.nota;
    return {
      estado: 'emitida',
      documentoId: String(n._id),
      fullNumber: n.fullNumber,
      cude: n.cufe,
      referenceType: n.referenceType === 'pos' ? 'pos' : 'invoice',
      referenceNumber: n.referenceNumber,
      concepto: conceptoDe(n.discrepancyCode),
      dianStatus: n.dianStatus,
    };
  }

  /** Nota sin referencia (Fase 6C). Lanza: la operación falla cerrado. */
  async emitirNotaSinReferencia(
    s: SolicitudNotaSinReferencia,
    user: JwtUser,
  ): Promise<NotaSinReferenciaEmitida> {
    const n = await this.einvoicing.emitirNotaSinReferencia(s, user);
    return {
      estado: 'emitida',
      documentoId: String(n._id),
      fullNumber: n.fullNumber,
      cude: n.cufe,
      referenceType: 'invoice',
      concepto: conceptoDe(n.discrepancyCode),
      dianStatus: n.dianStatus,
      total: n.payableAmount ?? n.total,
      // Reparto por venta y producto (tope cruzado de devoluciones y rebajas).
      asignaciones: (n.asignaciones ?? [])
        .filter((a) => a.saleId)
        .map((a) => ({
          saleId: String(a.saleId),
          productId: a.refKey,
          valor: a.base + (a.taxAmount ?? 0),
          impuesto: a.taxAmount ?? 0,
        })),
      iva: n.ivaTotal ?? 0,
      inc: n.incTotal ?? 0,
    };
  }

  /**
   * Un fallo aquí (DIAN caída, gate de ambiente, builder pendiente) deja el
   * documento en `draft`/`signed`/`sent` para la reconsulta; nunca sube.
   */
  async transmitir(documentoId: string, user: JwtUser): Promise<void> {
    try {
      await this.transmision.transmitir(documentoId, user);
    } catch (err) {
      this.logger.warn(
        `Documento ${documentoId}: transmisión pendiente (${(err as Error)?.name ?? 'Error'}).`,
      );
    }
  }
}
