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
  EmisionNotaVenta,
  NotaFiscalOperacion,
  SolicitudNotaVenta,
} from '../../sales/application/emision-documento-fiscal.puerto';

/**
 * Implementación del puerto `EMISION_DOCUMENTO_FISCAL` que usa el cobro
 * (ventas): POS anónimo, POS identificado o FEV, sobre `EinvoicingService`, y
 * la transmisión con `TransmisionDianService`.
 */
@Injectable()
export class EmisionDocumentoFiscalDian implements EmisionDocumentoFiscal, EmisionNotaVenta {
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
      concepto: n.discrepancyCode === '2' ? '2' : '1',
      dianStatus: n.dianStatus,
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
