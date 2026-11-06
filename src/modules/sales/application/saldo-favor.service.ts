import { BadRequestException, ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SaldoFavorCliente,
  SaldoFavorClienteDocument,
  SaldoFavorMovimiento,
  SaldoFavorMovimientoDocument,
  TipoMovimientoSaldoFavor,
} from '../infrastructure/schemas/saldo-favor.schema';
import { LedgerService } from '../../core-ledger/application/ledger.service';
import { ACC } from '../../core-ledger/domain/ledger.constants';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { cop, sumBy } from '../../finance/domain/money.util';

/** No alcanza el saldo a favor del cliente para lo que se quiere pagar. */
export const MENSAJE_SALDO_INSUFICIENTE = (saldo: number, monto: number) =>
  `El cliente tiene $${saldo} de saldo a favor y el pago con saldo a favor es de $${monto}.`;

export interface FilaSaldoFavor {
  customerId: string;
  customerName?: string;
  saldo: number;
  /** Σ abonos + reversos − consumos del auxiliar. */
  movimientos: number;
  /** saldo − movimientos: debe ser 0. Distinto de 0, un paso quedó a medias. */
  descuadre: number;
}

/**
 * Saldo a favor del cliente (PUC 2805, Fase 6C; hallazgo C1 del #125: hasta
 * ahora la 2805 solo se acreditaba).
 *
 * El diseño elegido es un registro por cliente (`saldo_favor_clientes`) más un
 * auxiliar inmutable (`saldo_favor_movimientos`), y no leer el saldo del
 * libro, por tres razones:
 * 1. El libro no lleva tercero: la 2805 es una sola cuenta para todos.
 * 2. Gastar el saldo tiene que ser ATÓMICO: dos cobros a la vez del mismo
 *    cliente leerían el mismo saldo del libro y gastarían dos veces. Aquí se
 *    descuenta con un `findOneAndUpdate` condicionado a `saldo ≥ monto`.
 * 3. Cada paso es idempotente por su origen (índice único del auxiliar), y la
 *    suma del auxiliar contra el saldo y contra el mayor de la 2805 se ve en
 *    el reporte: lo que no cuadra no queda escondido.
 *
 * Orden de cada paso: primero el movimiento (reserva el origen), después el
 * saldo. Si el saldo falla, se borra el movimiento. Un corte entre los dos
 * deja `descuadre` ≠ 0 en el reporte, nunca un peso gastado dos veces.
 */
@Injectable()
export class SaldoFavorService {
  private readonly logger = new Logger(SaldoFavorService.name);

  constructor(
    @InjectModel(SaldoFavorCliente.name)
    private readonly saldos: Model<SaldoFavorClienteDocument>,
    @InjectModel(SaldoFavorMovimiento.name)
    private readonly movimientos: Model<SaldoFavorMovimientoDocument>,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  async saldoDe(customerId: string): Promise<number> {
    if (!Types.ObjectId.isValid(customerId)) return 0;
    const fila = await this.saldos.findOne({ customerId: new Types.ObjectId(customerId) }).exec();
    return fila?.saldo ?? 0;
  }

  /**
   * Abona al cliente lo que la 2805 le acreditó (devolución, rebaja o
   * descuento «a favor»). Sin cliente queda en el auxiliar sin tercero: se ve
   * en el reporte, pero nadie lo puede gastar. Idempotente por origen.
   */
  async abonar(o: {
    customerId?: string | Types.ObjectId | null;
    customerName?: string;
    amount: number;
    sourceType: string;
    sourceId: string;
    sedeId?: string;
    memo?: string;
  }): Promise<void> {
    const amount = cop(o.amount);
    if (amount <= 0) return;
    const customerId = o.customerId ? new Types.ObjectId(String(o.customerId)) : null;
    const nuevo = await this.reservar('abono', { ...o, amount, customerId });
    if (!nuevo || !customerId) return;
    try {
      await this.saldos
        .findOneAndUpdate(
          { customerId },
          { $inc: { saldo: amount }, ...(o.customerName ? { $set: { customerName: o.customerName } } : {}) },
          { upsert: true, new: true },
        )
        .exec();
    } catch (err) {
      await this.soltar(nuevo);
      throw err;
    }
  }

  /**
   * Gasta saldo al cobrar una venta con `saldo_favor`. Atómico: si no alcanza,
   * 409 y no se toca nada. Idempotente por venta.
   */
  async consumir(o: { customerId: string; amount: number; saleId: string; sedeId?: string; memo?: string }): Promise<void> {
    const amount = cop(o.amount);
    if (amount <= 0) return;
    if (!Types.ObjectId.isValid(o.customerId)) throw new BadRequestException('Cliente inválido para el saldo a favor.');
    const customerId = new Types.ObjectId(o.customerId);
    const nuevo = await this.reservar('consumo', {
      customerId,
      amount,
      sourceType: 'sale',
      sourceId: o.saleId,
      sedeId: o.sedeId,
      memo: o.memo,
    });
    if (!nuevo) return;
    let hecho: SaldoFavorClienteDocument | null = null;
    try {
      hecho = await this.saldos
        .findOneAndUpdate({ customerId, saldo: { $gte: amount } }, { $inc: { saldo: -amount } }, { new: true })
        .exec();
    } catch (err) {
      await this.soltar(nuevo);
      throw err;
    }
    if (!hecho) {
      await this.soltar(nuevo);
      throw new ConflictException(MENSAJE_SALDO_INSUFICIENTE(await this.saldoDe(o.customerId), amount));
    }
  }

  /** Devuelve al cliente lo que gastó una venta que se anula. Idempotente; nunca lanza. */
  async revertirConsumo(saleId: string): Promise<void> {
    try {
      const consumo = await this.movimientos.findOne({ sourceType: 'sale', sourceId: saleId, tipo: 'consumo' }).exec();
      if (!consumo?.customerId) return;
      const nuevo = await this.reservar('reverso', {
        customerId: consumo.customerId,
        amount: consumo.amount,
        sourceType: 'sale',
        sourceId: saleId,
        sedeId: consumo.sedeId?.toString(),
        memo: 'Anulación de la venta',
      });
      if (!nuevo) return;
      await this.saldos
        .findOneAndUpdate({ customerId: consumo.customerId }, { $inc: { saldo: consumo.amount } }, { upsert: true })
        .exec();
    } catch (err) {
      this.logger.error(
        `CONCILIAR: la venta ${saleId} se anuló pero el saldo a favor no volvió al cliente: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Reporte de la 2805 por tercero: saldo de cada cliente, lo que dice su
   * auxiliar, lo abonado sin tercero y el mayor de la 2805 del libro, para
   * conciliar.
   */
  async reporte(): Promise<{
    filas: FilaSaldoFavor[];
    totalClientes: number;
    sinTercero: number;
    libro2805?: number;
    diferenciaLibro?: number;
  }> {
    const [saldos, agregados] = await Promise.all([
      this.saldos.find({}).sort({ saldo: -1 }).exec(),
      this.movimientos
        .aggregate<{ _id: Types.ObjectId | null; neto: number }>([
          {
            $group: {
              _id: '$customerId',
              neto: { $sum: { $cond: [{ $eq: ['$tipo', 'consumo'] }, { $multiply: ['$amount', -1] }, '$amount'] } },
            },
          },
        ])
        .exec(),
    ]);
    const neto = new Map(agregados.map((a) => [a._id ? String(a._id) : '', a.neto]));
    const ids = new Set([...saldos.map((s) => String(s.customerId)), ...[...neto.keys()].filter(Boolean)]);
    const porId = new Map(saldos.map((s) => [String(s.customerId), s]));
    const filas: FilaSaldoFavor[] = [...ids].map((id) => {
      const s = porId.get(id);
      const movimientos = cop(neto.get(id) ?? 0);
      const saldo = s?.saldo ?? 0;
      return { customerId: id, customerName: s?.customerName, saldo, movimientos, descuadre: saldo - movimientos };
    });
    const totalClientes = sumBy(filas, (f) => f.saldo);
    const sinTercero = cop(neto.get('') ?? 0);
    let libro2805: number | undefined;
    if (this.ledger) {
      const tb = await this.ledger.trialBalance({ to: fechaColombia() });
      const fila = tb.rows.find((r) => r.code === ACC.ANTICIPOS_CLIENTES);
      // Pasivo: el saldo a favor de los clientes es lo acreditado menos lo debitado.
      libro2805 = fila ? cop(fila.credit - fila.debit) : 0;
    }
    return {
      filas: filas.filter((f) => f.saldo !== 0 || f.descuadre !== 0),
      totalClientes,
      sinTercero,
      libro2805,
      diferenciaLibro: libro2805 === undefined ? undefined : libro2805 - totalClientes - sinTercero,
    };
  }

  /** Reserva el origen en el auxiliar. `null` si ya estaba (reintento). */
  private async reservar(
    tipo: TipoMovimientoSaldoFavor,
    o: {
      customerId: Types.ObjectId | null;
      amount: number;
      sourceType: string;
      sourceId: string;
      sedeId?: string;
      memo?: string;
    },
  ): Promise<SaldoFavorMovimientoDocument | null> {
    try {
      return await this.movimientos.create({
        customerId: o.customerId,
        tipo,
        amount: o.amount,
        sourceType: o.sourceType,
        sourceId: o.sourceId,
        sedeId: o.sedeId ? new Types.ObjectId(o.sedeId) : undefined,
        fecha: fechaColombia(),
        memo: o.memo,
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) return null;
      throw err;
    }
  }

  private async soltar(m: SaldoFavorMovimientoDocument): Promise<void> {
    await this.movimientos
      .deleteOne({ _id: m._id })
      .exec()
      .catch((err: unknown) =>
        this.logger.error(`CONCILIAR: no se pudo retirar el movimiento ${String(m._id)}: ${(err as Error).message}`),
      );
  }
}
