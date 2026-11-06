import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { waitUntil } from '@vercel/functions';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import type { SaleDocument } from '../infrastructure/schemas/sale.schema';
import type { DocumentoFiscalVenta } from '../domain/documento-fiscal';
import {
  EMISION_DOCUMENTO_FISCAL,
  type EmisionNotaVenta,
  type NotaFiscalOperacion,
  type SolicitudNotaVenta,
} from './emision-documento-fiscal.puerto';

/** El POS de una venta offline sin transcribir no existe todavía ante la DIAN. */
export const MENSAJE_NOTA_CONTINGENCIA =
  'La venta se hizo sin conexión y su documento POS sigue pendiente de contingencia: no existe ante la DIAN y la operación no lleva nota.';

/** La emisión del documento de la venta todavía corre en segundo plano. */
export const MENSAJE_DOCUMENTO_EN_PROCESO =
  'El documento electrónico de la venta todavía se está emitiendo. Espera unos segundos y vuelve a intentarlo.';

/**
 * Nota crédito / de ajuste de una devolución o anulación (Fase 6B), del lado
 * de ventas. Habla con `einvoicing` por el puerto `EMISION_DOCUMENTO_FISCAL`
 * (ModuleRef, sin importar el módulo: sería un ciclo), igual que el cobro.
 *
 * A diferencia del documento del cobro, la nota FALLA CERRADO: la operación
 * llama a `emitir` antes de mover stock, caja o libro y, si lanza, no mueve
 * nada. La transmisión sí va detrás de la respuesta (`waitUntil`): la caja no
 * espera a la DIAN, y un fallo deja la nota para la reconsulta.
 */
@Injectable()
export class NotaFiscalVentaService {
  private readonly logger = new Logger(NotaFiscalVentaService.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  private puerto(): EmisionNotaVenta | null {
    try {
      return this.moduleRef.get<EmisionNotaVenta>(EMISION_DOCUMENTO_FISCAL, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  async emitir(
    sale: SaleDocument,
    s: Omit<SolicitudNotaVenta, 'saleId'>,
    user: JwtUser,
  ): Promise<NotaFiscalOperacion> {
    const fiscal = (sale as { documentoFiscal?: DocumentoFiscalVenta }).documentoFiscal;
    const puerto = this.puerto();
    if (!puerto) {
      // Sin el módulo de facturación no se sabe si hay documento: si la venta
      // dice que lo tiene, no se sigue sin nota.
      if (fiscal?.estado === 'emitido' || fiscal?.estado === 'en_proceso') {
        throw new ServiceUnavailableException('La facturación electrónica no está disponible: no se puede emitir la nota.');
      }
      return { estado: 'sin_nota', motivo: 'La venta no tiene documento electrónico: la operación no lleva nota ante la DIAN.' };
    }
    const r = await puerto.emitirNota({ ...s, saleId: String(sale._id) }, user);
    if (r.estado === 'sin_nota') {
      if (fiscal?.estado === 'en_proceso') throw new ConflictException(MENSAJE_DOCUMENTO_EN_PROCESO);
      if (fiscal?.estado === 'pendiente_contingencia_07') return { ...r, motivo: MENSAJE_NOTA_CONTINGENCIA };
    }
    return r;
  }

  /** Transmite la nota detrás de la respuesta. Nunca lanza. */
  transmitirDetras(nota: NotaFiscalOperacion | undefined, user: JwtUser): void {
    if (nota?.estado !== 'emitida' || !nota.documentoId) return;
    const puerto = this.puerto();
    if (!puerto) return;
    const id = nota.documentoId;
    waitUntil(
      puerto.transmitir(id, user).catch((err: unknown) => {
        this.logger.warn(`Transmisión de la nota ${id} pendiente: ${(err as Error)?.name ?? 'Error'}`);
      }),
    );
  }
}
