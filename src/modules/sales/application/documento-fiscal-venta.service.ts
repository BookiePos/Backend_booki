import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { waitUntil } from '@vercel/functions';
import { Sale, SaleDocument } from '../infrastructure/schemas/sale.schema';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import type {
  DocumentoFiscalSolicitado,
  DocumentoFiscalVenta,
} from '../domain/documento-fiscal';
import {
  EMISION_DOCUMENTO_FISCAL,
  type DocumentoFiscalEmitido,
  type EmisionDocumentoFiscal,
} from './emision-documento-fiscal.puerto';

/** Token opcional para cambiar el plazo en pruebas. */
export const PLAZO_EMISION_FISCAL_MS = 'PLAZO_EMISION_FISCAL_MS';

/**
 * Cuánto espera el cobro a que el documento quede emitido. La emisión es
 * local (Mongo + descifrar el PIN + SHA-384), sin la DIAN: en condiciones
 * normales tarda decenas de milisegundos. El plazo solo protege el cobro de
 * una base lenta; si se pasa, la emisión sigue en segundo plano.
 */
const PLAZO_POR_DEFECTO_MS = 4_000;

const MENSAJE_ERROR_GENERICO =
  'No se pudo emitir el documento electrónico. La venta quedó registrada; vuelve a intentarlo desde el detalle de la venta.';

/**
 * Documento fiscal de la venta al cobrar (PR 7B, D1 y D5 del anexo POS).
 *
 * Reglas:
 * - Corre DESPUÉS de que la venta quedó confirmada y NUNCA lanza: un fallo
 *   deja la venta cobrada con `documentoFiscal.estado = 'error'` (y, si el
 *   documento alcanzó a crearse, en `draft`/`signed` para la reconsulta). El
 *   cobro no se revierte por un problema fiscal.
 * - La emisión (número, CUDE y QR) es SÍNCRONA pero acotada: el tiquete se
 *   imprime con el CUDE y el QR (D5), así que la respuesta del cobro los
 *   necesita. Si pasa del plazo, se responde `en_proceso` y la emisión termina
 *   con `waitUntil` (serverless: sin él, Vercel congela la función al
 *   responder y el trabajo quedaría a medias).
 * - La transmisión a la DIAN va SIEMPRE detrás de la respuesta (`waitUntil`):
 *   la caja no espera a la DIAN.
 * - Sin `solicitado` no hace nada: el comportamiento de antes.
 */
@Injectable()
export class DocumentoFiscalVentaService {
  private readonly logger = new Logger(DocumentoFiscalVentaService.name);
  private readonly plazoMs: number;

  constructor(
    private readonly moduleRef: ModuleRef,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @Optional() @Inject(PLAZO_EMISION_FISCAL_MS) plazoMs?: number,
  ) {
    this.plazoMs = plazoMs ?? PLAZO_POR_DEFECTO_MS;
  }

  async alCobrar(
    sale: SaleDocument,
    solicitado: DocumentoFiscalSolicitado | undefined,
    user: JwtUser,
    opts: { offline?: boolean } = {},
  ): Promise<SaleDocument> {
    if (!solicitado) return sale;
    try {
      const previo = (sale as { documentoFiscal?: DocumentoFiscalVenta }).documentoFiscal;
      // Reintento del mismo cobro (llave de idempotencia): ya quedó emitido.
      if (previo?.estado === 'emitido' && previo.solicitado === solicitado) return sale;

      const estado: DocumentoFiscalVenta = opts.offline
        ? { solicitado, estado: 'pendiente_contingencia_07' }
        : await this.emitirAcotado(sale, solicitado, user);
      await this.guardar(sale, estado);
    } catch (err) {
      // Defensa en profundidad: nada de aquí puede romper un cobro ya hecho.
      this.logger.error(
        `Documento fiscal de la venta ${String(sale._id)}: ${(err as Error)?.name ?? 'Error'}`,
      );
    }
    return sale;
  }

  private puerto(): EmisionDocumentoFiscal | null {
    try {
      return this.moduleRef.get<EmisionDocumentoFiscal>(EMISION_DOCUMENTO_FISCAL, {
        strict: false,
      });
    } catch {
      return null;
    }
  }

  private async emitirAcotado(
    sale: SaleDocument,
    solicitado: DocumentoFiscalSolicitado,
    user: JwtUser,
  ): Promise<DocumentoFiscalVenta> {
    const puerto = this.puerto();
    if (!puerto) {
      return { solicitado, estado: 'error', error: MENSAJE_ERROR_GENERICO };
    }

    const trabajo: Promise<DocumentoFiscalVenta> = puerto
      .emitir(String(sale._id), solicitado, user)
      .then((doc) => {
        this.transmitirDetras(puerto, doc, user);
        return this.emitido(solicitado, doc);
      })
      .catch((err: unknown) => ({
        solicitado,
        estado: 'error' as const,
        error: this.motivo(err),
      }));

    let vencido: ReturnType<typeof setTimeout> | undefined;
    const plazo = new Promise<null>((res) => {
      vencido = setTimeout(() => res(null), this.plazoMs);
    });
    const r = await Promise.race([trabajo, plazo]);
    clearTimeout(vencido);
    if (r) return r;

    // Pasó el plazo: la emisión sigue y, al terminar, deja su estado en la venta.
    waitUntil(
      trabajo
        .then((final) => this.guardar(sale, final))
        .catch(() => undefined),
    );
    return { solicitado, estado: 'en_proceso' };
  }

  private transmitirDetras(
    puerto: EmisionDocumentoFiscal,
    doc: DocumentoFiscalEmitido,
    user: JwtUser,
  ): void {
    waitUntil(
      puerto.transmitir(doc.documentoId, user).catch((err: unknown) => {
        this.logger.warn(
          `Transmisión del documento ${doc.documentoId} pendiente: ${(err as Error)?.name ?? 'Error'}`,
        );
      }),
    );
  }

  private emitido(
    solicitado: DocumentoFiscalSolicitado,
    doc: DocumentoFiscalEmitido,
  ): DocumentoFiscalVenta {
    return {
      solicitado,
      estado: 'emitido',
      documentoId: doc.documentoId,
      tipo: doc.tipo,
      fullNumber: doc.fullNumber,
      cude: doc.cude,
      qrUrl: doc.qrUrl,
      dianStatus: doc.dianStatus,
    };
  }

  /** Mensaje para la caja: el de las excepciones HTTP del emisor; nunca el de un error interno. */
  private motivo(err: unknown): string {
    if (err instanceof HttpException && err.getStatus() < 500) {
      const r = err.getResponse();
      const m =
        typeof r === 'string'
          ? r
          : (r as { message?: string | string[] }).message ?? err.message;
      return Array.isArray(m) ? m.join('; ') : m;
    }
    this.logger.error(`Emisión fiscal fallida: ${(err as Error)?.name ?? 'Error'}`);
    return MENSAJE_ERROR_GENERICO;
  }

  /** Deja el estado en la venta (y en la respuesta). Un fallo aquí no rompe el cobro. */
  private async guardar(sale: SaleDocument, estado: DocumentoFiscalVenta): Promise<void> {
    const s = sale as unknown as {
      set?: (k: string, v: unknown) => void;
      documentoFiscal?: DocumentoFiscalVenta;
    };
    if (typeof s.set === 'function') s.set('documentoFiscal', estado);
    else s.documentoFiscal = estado;
    try {
      await this.saleModel
        .updateOne({ _id: sale._id }, { $set: { documentoFiscal: estado } })
        .exec();
    } catch (err) {
      this.logger.error(
        `No se guardó el estado del documento fiscal de la venta ${String(sale._id)}: ${(err as Error)?.name ?? 'Error'}`,
      );
    }
  }
}
