import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  LedgerPendiente,
  LedgerPendienteDocument,
} from '../infrastructure/schemas/ledger-pendiente.schema';
import type {
  FalloDelLibro,
  OperacionConciliacion,
} from '../domain/conciliacion';

/**
 * Pendientes de conciliación del libro (checklist 1.13): los asientos que el
 * posteo automático no pudo escribir o reversar. Antes solo quedaba una línea
 * en el log; ahora queda una fila por empresa que la API expone y que el
 * script de reconstrucción resuelve.
 */
@Injectable()
export class LedgerConciliacionService {
  private readonly logger = new Logger('LedgerConciliacion');

  constructor(
    @InjectModel(LedgerPendiente.name)
    private readonly pendientes: Model<LedgerPendienteDocument>,
  ) {}

  /**
   * Anota el fallo. Nunca lanza: se llama desde el `catch` de un posteo
   * best-effort y no debe tumbar la operación de negocio que lo originó. Un
   * fallo repetido del mismo origen y operación suma intentos en la misma fila.
   */
  async registrar(fallo: FalloDelLibro): Promise<void> {
    try {
      await this.pendientes
        .findOneAndUpdate(
          {
            sourceType: fallo.sourceType,
            sourceId: fallo.sourceId,
            operacion: fallo.operacion,
            resuelto: false,
          },
          {
            $set: { error: fallo.error.slice(0, 500), ultimoFallo: new Date() },
            $inc: { intentos: 1 },
          },
          { upsert: true, setDefaultsOnInsert: false },
        )
        .exec();
    } catch (err) {
      this.logger.error(
        `CONCILIAR: tampoco se pudo anotar el pendiente ${fallo.operacion} ${fallo.sourceType} ${fallo.sourceId}: ${(err as Error).message}`,
      );
    }
  }

  async contarAbiertos(): Promise<number> {
    return this.pendientes.countDocuments({ resuelto: false }).exec();
  }

  async listarAbiertos(limit = 100): Promise<LedgerPendienteDocument[]> {
    return this.pendientes
      .find({ resuelto: false })
      .sort({ ultimoFallo: -1 })
      .limit(Math.min(Math.max(limit, 1), 500))
      .exec();
  }

  /**
   * Todos los pendientes abiertos, en páginas por `_id` (lo usa el script de
   * reconstrucción, que no puede quedarse con los primeros N).
   */
  async todosLosAbiertos(pagina = 500): Promise<LedgerPendienteDocument[]> {
    const todos: LedgerPendienteDocument[] = [];
    for (;;) {
      const ultimo = todos[todos.length - 1]?._id;
      const lote = await this.pendientes
        .find(ultimo ? { resuelto: false, _id: { $gt: ultimo } } : { resuelto: false })
        .sort({ _id: 1 })
        .limit(pagina)
        .exec();
      todos.push(...lote);
      if (lote.length < pagina) return todos;
    }
  }

  /** Cierra el pendiente abierto de ese origen y operación (si lo hay). */
  async resolver(
    sourceType: string,
    sourceId: string,
    operacion: OperacionConciliacion,
  ): Promise<void> {
    await this.pendientes
      .updateMany(
        { sourceType, sourceId, operacion, resuelto: false },
        { $set: { resuelto: true, resueltoEn: new Date() } },
      )
      .exec();
  }
}
