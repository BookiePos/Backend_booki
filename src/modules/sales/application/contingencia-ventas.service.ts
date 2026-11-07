import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { waitUntil } from '@vercel/functions';
import { Sale, type SaleDocument } from '../infrastructure/schemas/sale.schema';
import { SaleReturn, type SaleReturnDocument } from '../infrastructure/schemas/sale-return.schema';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { origenNotaAnulacion, type DocumentoFiscalVenta } from '../domain/documento-fiscal';
import {
  EMISION_DOCUMENTO_FISCAL,
  type DocumentoFiscalEmitido,
  type NotaFiscalOperacion,
  type TalonarioContingencia,
  type TranscripcionContingencia,
} from './emision-documento-fiscal.puerto';
import { NotaFiscalVentaService } from './nota-fiscal-venta.service';
import { SaleReturnsService } from './sale-returns.service';

/** La venta no está pendiente de contingencia (ni transcrita en contingencia). */
export const MENSAJE_NO_PENDIENTE =
  'La venta no tiene documento pendiente de contingencia: no hay nada que transcribir.';

/** Una nota pendiente de lo ocurrido en contingencia, con su resultado. */
export interface NotaTranscrita {
  operacion: 'devolucion' | 'rebaja' | 'anulacion';
  id: string;
  nota?: NotaFiscalOperacion;
  error?: string;
}

export interface ResultadoTranscripcion {
  documento: DocumentoFiscalEmitido;
  notas: NotaTranscrita[];
  /** Notas que quedaron sin emitir (la primera que falló detiene las siguientes). */
  pendientes: number;
}

/**
 * Transcripción de contingencia del FACTURADOR (Fase 9) desde ventas: la venta
 * hecha sin conexión (`pendiente_contingencia_07`) o en talonario recibe su
 * documento electrónico (POS 07 / FEV 03) y, en el mismo orden en que pasaron,
 * las notas de lo que le ocurrió mientras no lo tenía: devoluciones y rebajas
 * (por fecha) y, al final, la anulación (hallazgo (d) de la 6B). Cada nota se
 * emite contra el documento recién transcrito, así que referencia su CUDE
 * definitivo.
 *
 * - Fallar cerrado: si el documento no se puede transcribir, lanza y nada
 *   cambia. Si una nota falla, se detiene ahí (el orden importa) y se informa;
 *   reintentar es idempotente: el documento y las notas ya emitidas se
 *   devuelven por su llave (venta / `origen`).
 * - La transmisión va detrás de la respuesta (`waitUntil`): primero el
 *   documento y después sus notas (`procesarContingencia`). Si falla, la cola
 *   del cron de reconsulta la retoma dentro del plazo de 48 h.
 */
@Injectable()
export class ContingenciaVentasService {
  private readonly logger = new Logger(ContingenciaVentasService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(SaleReturn.name) private readonly returnModel: Model<SaleReturnDocument>,
    private readonly notas: NotaFiscalVentaService,
    private readonly devoluciones: SaleReturnsService,
  ) {}

  private puerto(): TranscripcionContingencia | null {
    try {
      const p = this.moduleRef.get<Partial<TranscripcionContingencia>>(EMISION_DOCUMENTO_FISCAL, { strict: false });
      return p?.transcribirContingencia && p.transmitirContingencia ? (p as TranscripcionContingencia) : null;
    } catch {
      return null;
    }
  }

  async transcribir(
    saleId: string,
    user: JwtUser,
    opts: { talonario?: TalonarioContingencia } = {},
  ): Promise<ResultadoTranscripcion> {
    const sale = Types.ObjectId.isValid(saleId) ? await this.saleModel.findById(saleId).exec() : null;
    if (!sale) throw new NotFoundException('Venta no encontrada');
    assertSedeAccess(user, sale.sedeId.toString());
    const fiscal = (sale as { documentoFiscal?: DocumentoFiscalVenta }).documentoFiscal;
    // Pendiente, o ya transcrita (reintento para terminar sus notas).
    if (!fiscal || (fiscal.estado !== 'pendiente_contingencia_07' && fiscal.estado !== 'emitido')) {
      throw new BadRequestException(MENSAJE_NO_PENDIENTE);
    }
    const puerto = this.puerto();
    if (!puerto) {
      throw new ServiceUnavailableException('La facturación electrónica no está disponible: no se puede transcribir.');
    }
    // Un `emitido` normal (no de contingencia) responde 409 desde el emisor.
    const documento = await puerto.transcribirContingencia(String(sale._id), fiscal.solicitado, opts, user);
    await this.marcarEmitido(sale, fiscal, documento);

    const notas = await this.emitirNotasPendientes(sale, user);
    const pendientes = notas.filter((n) => n.error).length;
    const id = documento.documentoId;
    waitUntil(puerto.transmitirContingencia(id, user));
    return { documento, notas, pendientes };
  }

  /** La venta pasa a `emitido` con su documento de contingencia. No pisa otro documento. */
  private async marcarEmitido(
    sale: SaleDocument,
    fiscal: DocumentoFiscalVenta,
    d: DocumentoFiscalEmitido,
  ): Promise<void> {
    const estado: DocumentoFiscalVenta = {
      solicitado: fiscal.solicitado,
      estado: 'emitido',
      documentoId: d.documentoId,
      tipo: d.tipo,
      fullNumber: d.fullNumber,
      cude: d.cude,
      qrUrl: d.qrUrl,
      dianStatus: d.dianStatus,
    };
    await this.saleModel
      .updateOne(
        {
          _id: sale._id,
          $or: [{ 'documentoFiscal.estado': 'pendiente_contingencia_07' }, { 'documentoFiscal.documentoId': d.documentoId }],
        },
        { $set: { documentoFiscal: estado } },
      )
      .exec();
  }

  /**
   * Las notas que la operación no pudo emitir porque la venta no tenía
   * documento: devoluciones y rebajas por fecha de creación y, si la venta se
   * anuló, la anulación al final (después de anular no hay más operaciones).
   * Se detiene en la primera que falle.
   */
  private async emitirNotasPendientes(sale: SaleDocument, user: JwtUser): Promise<NotaTranscrita[]> {
    const registros = await this.returnModel
      .find({ saleId: sale._id, 'notaFiscal.estado': { $ne: 'emitida' } })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    const out: NotaTranscrita[] = [];
    for (const registro of registros) {
      const operacion = registro.kind === 'rebaja' ? 'rebaja' : 'devolucion';
      const id = String(registro._id);
      try {
        const nota = await this.notas.emitir(sale, this.devoluciones.solicitudNota(registro, sale), user);
        await this.returnModel.updateOne({ _id: registro._id }, { $set: { notaFiscal: nota } }).exec();
        out.push({ operacion, id, nota });
      } catch (err) {
        out.push({ operacion, id, error: this.motivo(err) });
        return out;
      }
    }
    const anulacion = (sale as { notaAnulacion?: { estado?: string } }).notaAnulacion;
    if (sale.status === 'void' && anulacion?.estado !== 'emitida') {
      const id = String(sale._id);
      try {
        const nota = await this.notas.emitir(
          sale,
          { origen: origenNotaAnulacion(id), concepto: '2', motivo: `Anulación de la venta ${sale.saleNumber}` },
          user,
        );
        await this.saleModel.updateOne({ _id: sale._id }, { $set: { notaAnulacion: nota } }).exec();
        out.push({ operacion: 'anulacion', id, nota });
      } catch (err) {
        out.push({ operacion: 'anulacion', id, error: this.motivo(err) });
      }
    }
    return out;
  }

  /** El mensaje de una excepción HTTP de regla; nunca el de un error interno. */
  private motivo(err: unknown): string {
    const status = (err as { getStatus?: () => number })?.getStatus?.();
    if (typeof status === 'number' && status < 500) return (err as Error).message;
    this.logger.error(`Nota de contingencia fallida: ${(err as Error)?.name ?? 'Error'}`);
    return 'No se pudo emitir la nota; inténtalo de nuevo.';
  }
}
