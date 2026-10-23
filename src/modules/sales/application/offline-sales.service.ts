import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Counter,
  CounterDocument,
} from '../infrastructure/schemas/counter.schema';
import {
  OfflineReservation,
  OfflineReservationDocument,
} from '../infrastructure/schemas/offline-reservation.schema';
import {
  OfflineSaleClaim,
  OfflineSaleClaimDocument,
} from '../infrastructure/schemas/offline-sale-claim.schema';
import { Sale, SaleDocument } from '../infrastructure/schemas/sale.schema';
import {
  CajaSession,
  CajaSessionDocument,
} from '../../caja/infrastructure/schemas/caja-session.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import {
  OFFLINE_BLOCK_DEFAULT,
  OFFLINE_BLOCK_MAX,
  OFFLINE_PREFIX,
  formatOfflineNumber,
  offlineCounterId,
  offlineSaleViolations,
  parseOfflineNumber,
  soldAtIsPlausible,
} from '../domain/offline-sales';
import { SalesService } from './sales.service';
import { isOfflineConflict, offlineConflict } from './offline-conflict';
import {
  ReserveOfflineNumbersDto,
  SyncOfflineSaleDto,
} from './dto/offline-sale.dto';

/** Un candado en `processing` más viejo que esto es de una petición que murió. */
const CLAIM_STALE_MS = 2 * 60_000;

export interface OfflineReservationView {
  reservationId: string;
  sedeId: string;
  cajaSessionId: string;
  prefix: string;
  from: number;
  to: number;
  createdAt?: Date;
}

export interface OfflineSyncResult {
  /** `creada` la primera vez; `duplicada` si ese UUID ya estaba registrado. */
  status: 'creada' | 'duplicada';
  sale: SaleDocument;
}

/**
 * Ventas sin internet (ítem 6.3): reserva de consecutivos y sincronización.
 *
 * La venta en sí la registra `SalesService.create`, la misma de siempre:
 * inventario FEFO, asiento, turno de caja y arqueo salen igual que en una venta
 * en línea. Este servicio pone delante lo que la hace segura de reintentar:
 *
 * 1. El número tiene que ser de un bloque reservado por ESTE usuario en ESTA
 *    sede, y la fecha tiene que ser creíble para ese bloque.
 * 2. Un candado por UUID (índice único) se toma ANTES de tocar inventario. Un
 *    reenvío, o dos pestañas sincronizando a la vez, no vuelven a vender.
 * 3. Si el registro choca (turno cerrado, sin stock, producto inactivo, total
 *    distinto), el candado se suelta y el terminal guarda la venta en su
 *    bandeja con el motivo. Nada se pierde ni queda a medias.
 */
@Injectable()
export class OfflineSalesService {
  private readonly logger = new Logger(OfflineSalesService.name);

  constructor(
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
    @InjectModel(OfflineReservation.name)
    private readonly reservationModel: Model<OfflineReservationDocument>,
    @InjectModel(OfflineSaleClaim.name)
    private readonly claimModel: Model<OfflineSaleClaimDocument>,
    @InjectModel(Sale.name)
    private readonly saleModel: Model<SaleDocument>,
    @InjectModel(CajaSession.name)
    private readonly cajaSessionModel: Model<CajaSessionDocument>,
    private readonly sales: SalesService,
  ) {}

  /**
   * Entrega un bloque de consecutivos `FVC-` atado al turno abierto de la sede.
   * El rango sale de un único `$inc` atómico: dos terminales (o dos pestañas)
   * que piden a la vez reciben rangos disjuntos.
   */
  async reserve(
    dto: ReserveOfflineNumbersDto,
    user: JwtUser,
  ): Promise<OfflineReservationView> {
    assertSedeAccess(user, dto.sedeId);
    const sedeOid = new Types.ObjectId(dto.sedeId);
    const caja = await this.cajaSessionModel
      .findOne({ sedeId: sedeOid, status: 'open' })
      .exec();
    if (!caja) {
      throw new BadRequestException(
        'Abre la caja de la sede antes de preparar el modo sin conexión',
      );
    }
    const count = Math.min(
      Math.max(dto.count ?? OFFLINE_BLOCK_DEFAULT, 1),
      OFFLINE_BLOCK_MAX,
    );
    const counter = await this.counterModel
      .findOneAndUpdate(
        { _id: offlineCounterId(dto.sedeId) },
        { $inc: { seq: count } },
        { upsert: true, returnDocument: 'after' },
      )
      .exec();
    const to = counter.seq;
    const from = to - count + 1;
    const doc = await this.reservationModel.create({
      sedeId: sedeOid,
      cajaSessionId: caja._id,
      userId: user.userId,
      userEmail: user.email,
      deviceId: dto.deviceId,
      prefix: OFFLINE_PREFIX,
      from,
      to,
    });
    return this.view(doc);
  }

  /**
   * Reservas de la sede con lo que se usó de cada una: es la traza de la serie
   * de contingencia (qué número se entregó a quién y cuáles quedaron sin usar).
   */
  async listReservations(sedeId: string, user: JwtUser) {
    assertSedeAccess(user, sedeId);
    const sedeOid = new Types.ObjectId(sedeId);
    const reservas = await this.reservationModel
      .find({ sedeId: sedeOid })
      .sort({ createdAt: -1 })
      .limit(50)
      .exec();
    const ids = reservas.map((r) => r._id);
    const usados = await this.claimModel
      .find({ reservationId: { $in: ids }, status: 'done' })
      .exec();
    return reservas.map((r) => {
      const propios = usados
        .filter((c) => c.reservationId.toString() === r._id.toString())
        .map((c) => c.saleNumber)
        .sort();
      return {
        ...this.view(r),
        userEmail: r.userEmail,
        deviceId: r.deviceId,
        used: propios,
        usedCount: propios.length,
        unusedCount: r.to - r.from + 1 - propios.length,
      };
    });
  }

  /** Registra una venta offline. Idempotente por `offlineId`. */
  async sync(dto: SyncOfflineSaleDto, user: JwtUser): Promise<OfflineSyncResult> {
    const sedeId = dto.sale.sedeId;
    assertSedeAccess(user, sedeId);

    const prohibido = offlineSaleViolations(dto.sale);
    if (prohibido.length > 0) {
      throw offlineConflict('NO_PERMITIDA_OFFLINE', prohibido.join('. '));
    }

    // Ya registrada (reenvío): se devuelve la misma venta, sin tocar nada.
    const previa = await this.ventaPrevia(dto.offlineId, sedeId);
    if (previa) return { status: 'duplicada', sale: previa };

    const reserva = await this.reservationModel
      .findOne({
        _id: new Types.ObjectId(dto.reservationId),
        sedeId: new Types.ObjectId(sedeId),
      })
      .exec();
    const n = parseOfflineNumber(dto.saleNumber);
    if (!reserva || n === null || n < reserva.from || n > reserva.to) {
      throw offlineConflict(
        'NUMERO_INVALIDO',
        `El consecutivo ${dto.saleNumber} no pertenece a una reserva de esta sede`,
      );
    }
    if (reserva.userId !== user.userId) {
      throw offlineConflict(
        'NUMERO_INVALIDO',
        `El consecutivo ${dto.saleNumber} se reservó para otro usuario`,
      );
    }
    const soldAt = new Date(dto.soldAt);
    if (!soldAtIsPlausible(soldAt, reserva.createdAt ?? new Date(0), new Date())) {
      throw offlineConflict(
        'FECHA_INVALIDA',
        'La fecha de la venta no cuadra con la reserva de su consecutivo',
      );
    }

    // Turno: el de la reserva. Si ya se cerró, solo entra al abierto si quien
    // sincroniza lo pide desde la bandeja (el efectivo está en el cajón actual).
    let cajaSessionId = reserva.cajaSessionId.toString();
    const turnoReserva = await this.cajaSessionModel
      .findOne({ _id: reserva.cajaSessionId, status: 'open' })
      .exec();
    if (!turnoReserva) {
      if (!dto.useOpenShift) {
        throw offlineConflict(
          'TURNO_CERRADO',
          'El turno de caja en el que se cobró esta venta ya se cerró',
        );
      }
      const abierto = await this.cajaSessionModel
        .findOne({ sedeId: new Types.ObjectId(sedeId), status: 'open' })
        .exec();
      if (!abierto) {
        throw offlineConflict(
          'TURNO_CERRADO',
          'No hay un turno de caja abierto en la sede para registrar la venta',
        );
      }
      cajaSessionId = abierto._id.toString();
    }

    await this.tomarCandado(dto, reserva._id, user);

    let sale: SaleDocument;
    try {
      sale = await this.sales.create(dto.sale, user, undefined, {
        offline: {
          offlineId: dto.offlineId,
          saleNumber: formatOfflineNumber(n),
          soldAt,
          cajaSessionId,
          expectedGrandTotal: dto.expectedGrandTotal,
        },
      });
    } catch (err) {
      // La venta no se registró: se suelta el candado para poder reintentar
      // desde la bandeja con el mismo UUID.
      await this.claimModel.deleteOne({ _id: dto.offlineId, status: 'processing' }).exec();
      throw this.clasificar(err);
    }

    await this.claimModel
      .updateOne(
        { _id: dto.offlineId },
        { $set: { status: 'done', saleId: sale._id } },
      )
      .exec();
    return { status: 'creada', sale };
  }

  /**
   * La venta de este UUID si ya existe. Un candado `done` la referencia; uno en
   * `processing` reciente es otra petición en curso; uno viejo es de una
   * petición que murió, y se mira si alcanzó a crear la venta.
   */
  private async ventaPrevia(
    offlineId: string,
    sedeId: string,
  ): Promise<SaleDocument | null> {
    const venta = await this.saleModel.findOne({ offlineId }).exec();
    if (venta) {
      if (venta.sedeId.toString() !== sedeId) {
        throw new ForbiddenException('Esa venta es de otra sede');
      }
      await this.claimModel
        .updateOne({ _id: offlineId }, { $set: { status: 'done', saleId: venta._id } })
        .exec();
      return venta;
    }
    const candado = await this.claimModel.findById(offlineId).exec();
    if (!candado) return null;
    const edad = Date.now() - (candado.createdAt?.getTime() ?? 0);
    if (candado.status === 'processing' && edad < CLAIM_STALE_MS) {
      throw offlineConflict('EN_PROCESO', 'Esta venta se está registrando; reintenta en un momento');
    }
    // `done` sin venta (borrada a mano) o `processing` huérfano: se libera.
    this.logger.warn(`Candado offline ${offlineId} sin venta; se libera para reintentar`);
    await this.claimModel.deleteOne({ _id: offlineId }).exec();
    return null;
  }

  private async tomarCandado(
    dto: SyncOfflineSaleDto,
    reservationId: Types.ObjectId,
    user: JwtUser,
  ): Promise<void> {
    try {
      await this.claimModel.create({
        _id: dto.offlineId,
        sedeId: new Types.ObjectId(dto.sale.sedeId),
        saleNumber: dto.saleNumber,
        reservationId,
        userId: user.userId,
        status: 'processing',
      });
    } catch (err) {
      const e = err as { code?: number; keyPattern?: Record<string, unknown> };
      if (e?.code !== 11000) throw err;
      if (e.keyPattern && 'saleNumber' in e.keyPattern) {
        throw offlineConflict(
          'NUMERO_USADO',
          `El consecutivo ${dto.saleNumber} ya lo usó otra venta`,
        );
      }
      // Mismo UUID tomado entre la consulta y el insert: otra petición en curso.
      throw offlineConflict('EN_PROCESO', 'Esta venta se está registrando; reintenta en un momento');
    }
  }

  /** Lleva un rechazo de la venta a un conflicto con motivo; lo demás sube igual. */
  private clasificar(err: unknown): unknown {
    if (isOfflineConflict(err)) return err;
    if (err instanceof HttpException && err.getStatus() >= 400 && err.getStatus() < 500) {
      return offlineConflict('RECHAZADA', err.message);
    }
    // 5xx / caída de base: el terminal la deja pendiente y reintenta.
    return err;
  }

  private view(r: OfflineReservationDocument): OfflineReservationView {
    return {
      reservationId: r._id.toString(),
      sedeId: r.sedeId.toString(),
      cajaSessionId: r.cajaSessionId.toString(),
      prefix: r.prefix,
      from: r.from,
      to: r.to,
      createdAt: r.createdAt,
    };
  }
}
