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
 * El saldo es ÚNICO POR EMPRESA (no por sede): el cliente gasta en cualquier
 * sede lo que le quedó a favor en otra, aunque cada asiento de la 2805 lleve
 * la sede donde se originó. Por eso el reporte no se filtra por sede y se le
 * niega a quien está limitado a unas sedes.
 *
 * 3. Cada paso es idempotente por su origen (índice único del auxiliar), y la
 *    suma del auxiliar contra el saldo y contra el mayor de la 2805 se ve en
 *    el reporte: lo que no cuadra no queda escondido.
 *
 * Orden de cada paso: primero el movimiento (reserva el origen, `aplicado:
 * false`), después se RECLAMA (`aplicado: true`, condicionado) y se mueve el
 * saldo. Si el saldo falla, el movimiento se retira y el error sube. Un corte
 * entre la reserva y el saldo deja el movimiento sin aplicar, y el barrido de
 * varadas del cron diario lo aplica (`aplicarPendientes`). Reclamar antes de
 * aplicar hace que nunca se aplique dos veces; un corte justo después del
 * reclamo se ve como `descuadre` ≠ 0 en el reporte.
 */
@Injectable()
export class SaldoFavorService {
  private readonly logger = new Logger(SaldoFavorService.name);
  /** Antigüedad a partir de la cual el barrido aplica un movimiento sin efecto. */
  static readonly VARADO_MS = 10 * 60 * 1000;

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
   * en el reporte, pero nadie lo puede gastar. Idempotente por origen. Si el
   * saldo no se puede actualizar, el movimiento se retira y el error sube.
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
      await this.aplicar(nuevo, o.customerName);
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
    let hecho: boolean;
    try {
      hecho = await this.aplicar(nuevo);
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
    let nuevo: SaldoFavorMovimientoDocument | null = null;
    try {
      const consumo = await this.movimientos.findOne({ sourceType: 'sale', sourceId: saleId, tipo: 'consumo' }).exec();
      if (!consumo?.customerId) return;
      nuevo = await this.reservar('reverso', {
        customerId: consumo.customerId,
        amount: consumo.amount,
        sourceType: 'sale',
        sourceId: saleId,
        sedeId: consumo.sedeId?.toString(),
        memo: 'Anulación de la venta',
      });
      if (!nuevo) return;
      await this.aplicar(nuevo);
    } catch (err) {
      // Sin el saldo, el reverso no queda en el auxiliar: un reintento lo vuelve a intentar.
      if (nuevo) await this.soltar(nuevo);
      this.logger.error(
        `CONCILIAR: la venta ${saleId} se anuló pero el saldo a favor no volvió al cliente: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Aplica al saldo un movimiento reservado. Primero lo RECLAMA (`aplicado`
   * de false a true, condicionado): quien no lo reclama no lo aplica, así el
   * barrido y la petición nunca lo aplican dos veces. Devuelve `false` si un
   * consumo no alcanza (lo reclamado se suelta) o si otro ya lo reclamó.
   * Si el saldo falla, lo devuelve a «sin aplicar» y lanza.
   */
  private async aplicar(m: SaldoFavorMovimientoDocument, customerName?: string): Promise<boolean> {
    if (!m.customerId) return true;
    const reclamado = await this.movimientos
      .findOneAndUpdate({ _id: m._id, aplicado: false }, { $set: { aplicado: true } }, { new: true })
      .exec();
    if (!reclamado) return false;
    const desmarcar = () =>
      this.movimientos.updateOne({ _id: m._id }, { $set: { aplicado: false } }).exec().catch(() => undefined);
    try {
      if (m.tipo === 'consumo') {
        const hecho = await this.saldos
          .findOneAndUpdate({ customerId: m.customerId, saldo: { $gte: m.amount } }, { $inc: { saldo: -m.amount } }, { new: true })
          .exec();
        if (!hecho) {
          await desmarcar();
          return false;
        }
        return true;
      }
      await this.saldos
        .findOneAndUpdate(
          { customerId: m.customerId },
          { $inc: { saldo: m.amount }, ...(customerName ? { $set: { customerName } } : {}) },
          { upsert: true, new: true },
        )
        .exec();
      return true;
    } catch (err) {
      await desmarcar();
      throw err;
    }
  }

  /**
   * Barrido de varadas (lo llama `DevolucionesVaradasBarrido` dentro del
   * `TenantContext` de cada empresa): aplica los movimientos que quedaron
   * reservados sin efecto (un corte entre el auxiliar y el saldo) hace más de
   * `VARADO_MS`. Un consumo que ya no alcanza no se aplica: queda para
   * conciliar y cuenta como fallido.
   */
  async aplicarPendientes(): Promise<{ aplicados: number; fallidos: number }> {
    const limite = new Date(Date.now() - SaldoFavorService.VARADO_MS);
    const pendientes = await this.movimientos
      .find({ aplicado: false, customerId: { $ne: null }, createdAt: { $lt: limite } })
      .sort({ createdAt: 1 })
      .limit(200)
      .exec();
    const r = { aplicados: 0, fallidos: 0 };
    for (const m of pendientes) {
      try {
        if (await this.aplicar(m)) r.aplicados += 1;
        else if (m.tipo === 'consumo') {
          r.fallidos += 1;
          this.logger.error(`CONCILIAR: el consumo de saldo a favor ${String(m._id)} (venta ${m.sourceId}) ya no alcanza.`);
        }
      } catch (err) {
        r.fallidos += 1;
        this.logger.warn(`Movimiento de saldo a favor ${String(m._id)} sin aplicar: ${(err as Error).message}`);
      }
    }
    return r;
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
        // Sin tercero no hay saldo que mover: nace aplicado.
        aplicado: !o.customerId,
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
