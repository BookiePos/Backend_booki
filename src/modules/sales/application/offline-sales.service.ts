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
  OfflineConflictDocument,
  OfflineConflictRecord,
} from '../infrastructure/schemas/offline-conflict.schema';
import {
  CajaSession,
  CajaSessionDocument,
} from '../../caja/infrastructure/schemas/caja-session.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import {
  OFFLINE_BLOCK_DEFAULT,
  OFFLINE_BLOCK_MAX,
  OFFLINE_PREFIX,
  formatOfflineNumber,
  offlineCounterId,
  offlineSaleViolations,
  parseOfflineNumber,
  reservationExpiresAt,
  soldAtEnTurno,
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
  /** Pasada esta hora los números del bloque ya no sirven para cobrar (48 h). */
  expiresAt?: Date;
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
    @InjectModel(OfflineConflictRecord.name)
    private readonly conflictModel: Model<OfflineConflictDocument>,
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

  /**
   * Bandeja de conflictos de la sede guardada en el servidor: ventas cobradas
   * sin red que no se pudieron registrar. La ve quien autoriza anulaciones
   * (permiso en el controlador) y solo de sus sedes.
   */
  async listConflicts(sedeId: string, user: JwtUser) {
    assertSedeAccess(user, sedeId);
    return this.conflictModel
      .find({ sedeId: new Types.ObjectId(sedeId), status: 'abierto' })
      .sort({ updatedAt: -1 })
      .limit(200)
      .exec();
  }

  /**
   * Registra una venta offline. Idempotente por `offlineId`. Si choca, el
   * conflicto queda también en la bandeja del servidor.
   */
  async sync(dto: SyncOfflineSaleDto, user: JwtUser): Promise<OfflineSyncResult> {
    assertSedeAccess(user, dto.sale.sedeId);
    if (dto.override && !user.permissions.includes(PERMISSIONS.POS_VOID_AUTHORIZE)) {
      throw new ForbiddenException(
        'Registrar una venta offline con lo cobrado requiere autorizar anulaciones',
      );
    }
    let r: OfflineSyncResult;
    try {
      r = await this.syncInterno(dto, user);
    } catch (err) {
      await this.guardarConflicto(dto, user, err);
      throw err;
    }
    await this.conflictModel
      .updateOne(
        { _id: dto.offlineId },
        {
          $set: {
            status: 'resuelto',
            saleId: r.sale._id,
            resolvedById: user.userId,
            resolvedAt: new Date(),
          },
        },
      )
      .exec()
      .catch((e: Error) =>
        this.logger.warn(`No se pudo cerrar el conflicto offline ${dto.offlineId}: ${e.message}`),
      );
    return r;
  }

  /** Deja el conflicto en la bandeja del servidor (best-effort). */
  private async guardarConflicto(
    dto: SyncOfflineSaleDto,
    user: JwtUser,
    err: unknown,
  ): Promise<void> {
    if (!isOfflineConflict(err)) return;
    const body = err.getResponse() as { reason?: string; message?: string };
    if (!body.reason || body.reason === 'EN_PROCESO') return;
    try {
      await this.conflictModel
        .updateOne(
          { _id: dto.offlineId },
          {
            $set: {
              sedeId: new Types.ObjectId(dto.sale.sedeId),
              saleNumber: dto.saleNumber,
              reason: body.reason,
              message: body.message ?? body.reason,
              userId: user.userId,
              userEmail: user.email,
              soldAt: new Date(dto.soldAt),
              expectedGrandTotal: dto.expectedGrandTotal,
              payload: JSON.parse(JSON.stringify(dto)) as Record<string, unknown>,
              status: 'abierto',
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (e) {
      // La copia del terminal sigue: perder la del servidor no pierde la venta.
      this.logger.warn(
        `No se pudo guardar el conflicto offline ${dto.offlineId}: ${(e as Error).message}`,
      );
    }
  }

  private async syncInterno(
    dto: SyncOfflineSaleDto,
    user: JwtUser,
  ): Promise<OfflineSyncResult> {
    const sedeId = dto.sale.sedeId;

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
    // El número es de quien lo reservó. La excepción es quien autoriza
    // anulaciones registrando con lo cobrado (permiso ya exigido en `sync`):
    // resuelve desde la bandeja del servidor la venta de otro cajero.
    if (reserva.userId !== user.userId && !dto.override) {
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

    // Turno: el de la reserva, y el cobro tiene que caer entre su apertura y
    // su cierre. Si ya se cerró, solo entra al abierto si quien sincroniza lo
    // pide desde la bandeja (el efectivo está en el cajón actual).
    let cajaSessionId = reserva.cajaSessionId.toString();
    let turnoOrigenId: string | undefined;
    const turnoReserva = await this.cajaSessionModel
      .findOne({ _id: reserva.cajaSessionId })
      .exec();
    if (
      turnoReserva?.openedAt &&
      !soldAtEnTurno(
        soldAt,
        turnoReserva.openedAt,
        turnoReserva.status === 'open' ? undefined : turnoReserva.closedAt,
      )
    ) {
      throw offlineConflict(
        'FECHA_INVALIDA',
        'La fecha de la venta queda fuera del turno de caja de su reserva',
      );
    }
    if (!turnoReserva || turnoReserva.status !== 'open') {
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
      turnoOrigenId = reserva.cajaSessionId.toString();
    }

    // Con lo cobrado: el precio por producto que salió en el comprobante.
    const chargedPrices = dto.override
      ? Object.fromEntries(
          (dto.chargedLines ?? []).map((l) => [l.productId, l.unitPrice]),
        )
      : undefined;

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
          turnoOrigenId,
          chargedPrices,
          override: dto.override
            ? { byUserId: user.userId, byEmail: user.email, at: new Date() }
            : undefined,
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
    if (turnoOrigenId) {
      // El efectivo de esta venta se contó en el cajón de un turno que ya se
      // cerró (su arqueo pudo dar sobrante) y la venta entra a este. Solo se
      // deja constancia en el turno: no se inventan asientos ni movimientos;
      // el traslado entre arqueos lo concilia quien cierra.
      await this.cajaSessionModel
        .updateOne(
          { _id: new Types.ObjectId(cajaSessionId) },
          {
            $push: {
              offlineNotes:
                `${formatOfflineNumber(n)} se cobró sin conexión en el turno ${turnoOrigenId}, ` +
                `ya cerrado: su efectivo (${dto.expectedGrandTotal} COP) pudo quedar contado en ese arqueo.`,
            },
          },
        )
        .exec()
        .catch((e: Error) =>
          this.logger.warn(`No se pudo anotar el turno de ${dto.offlineId}: ${e.message}`),
        );
    }
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
      expiresAt: r.createdAt ? reservationExpiresAt(r.createdAt) : undefined,
    };
  }
}
