import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../infrastructure/schemas/sale.schema';
import {
  PlatformSettlement,
  PlatformSettlementDocument,
} from '../infrastructure/schemas/platform-settlement.schema';
import { Sede, SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import { CreatePlatformSettlementDto } from './dto/platform-orders.dto';
import {
  PLATFORM_LABELS,
  PlatformCode,
  fechaContablePedido,
  platformReceivable,
  validateSettlement,
} from '../domain/platform-orders';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { TreasuryPostingService } from '../../finance/treasury/treasury-posting.service';
import { BusinessService } from '../../control/application/business.service';
import { perfilFiscalDeSede } from '../../core-tax/application/perfil-fiscal';
import { admiteIvaDescontable } from '../../core-tax/domain/sale-tax';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { cop, sumBy } from '../../finance/domain/money.util';

/**
 * Liquidación de las plataformas de domicilio (ítem 7.5): cuando Rappi, DiDi
 * Food o Uber Eats consignan, se cancela la cuenta por cobrar de los pedidos y
 * se reconocen la comisión, las retenciones y la diferencia de precio.
 *
 * Ecuación: consignado + comisión + IVA de la comisión + retenciones
 *           = bruto de los pedidos + ajuste de precio.
 *
 * Orden y garantías (Mongo standalone, sin transacciones):
 *   1. Se crea la liquidación (su id es el `sourceId` del asiento).
 *   2. Se RESERVAN los pedidos con un update condicional (sin liquidar,
 *      completados, de esta sede y plataforma). Si alguno ya no está libre, se
 *      suelta lo reservado y se rechaza: un pedido jamás se cobra dos veces.
 *   3. Asiento (idempotente por origen; si falla queda CONCILIAR como el resto
 *      del libro) y tesorería.
 * Anular es en tres pasos que se pueden reintentar: `voiding` → reversa del
 * asiento (si falla, NO se liberan los pedidos) → liberar → `void`.
 */
@Injectable()
export class PlatformSettlementsService {
  private readonly logger = new Logger(PlatformSettlementsService.name);

  constructor(
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(PlatformSettlement.name)
    private readonly settlementModel: Model<PlatformSettlementDocument>,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly treasury: TreasuryPostingService,
    /** Responsabilidad de IVA de la sede: decide si el IVA de la comisión se descuenta. */
    @InjectModel(Sede.name) private readonly sedeModel: Model<SedeDocument>,
    /** Control-plane: el giro del negocio cuando el token no lo trae. */
    private readonly businesses: BusinessService,
  ) {}

  async create(dto: CreatePlatformSettlementDto, user: JwtUser): Promise<PlatformSettlementDocument> {
    assertSedeAccess(user, dto.sedeId);
    const ids = [...new Set(dto.saleIds)].map((id) => new Types.ObjectId(id));
    const sedeId = new Types.ObjectId(dto.sedeId);

    // Los pedidos candidatos: de esta sede y plataforma, completados y libres.
    const libres = await this.saleModel
      .find({
        _id: { $in: ids },
        sedeId,
        status: 'completed',
        'platform.code': dto.platform,
        'platform.settlementId': { $exists: false },
      })
      .select('total deliveryFee platform createdAt')
      .exec();
    if (libres.length !== ids.length) {
      throw new BadRequestException(
        'Algún pedido no es de esta sede y plataforma, está anulado o ya fue liquidado',
      );
    }
    const gross = sumBy(libres, (s) => platformReceivable(s));
    const commission = cop(dto.commission);
    const commissionIva = cop(dto.commissionIva ?? 0);
    const retefuente = cop(dto.retefuente ?? 0);
    const reteIca = cop(dto.reteIca ?? 0);
    const reteIva = cop(dto.reteIva ?? 0);
    const ajustePrecio = cop(dto.ajustePrecio ?? 0);
    const received = cop(dto.received);
    const problema = validateSettlement({
      gross, received, commission, commissionIva, retefuente, reteIca, reteIva, ajustePrecio,
    });
    if (problema) throw new BadRequestException(problema);

    // Fecha: no futura, no anterior al pedido más reciente que se liquida (el
    // libro va en orden) y, si es de un mes anterior, se lleva a hoy (mismo
    // criterio que la reversa, `fechaDeReversa`).
    const hoy = fechaColombia();
    const pedida = dto.date ?? hoy;
    const fecha = fechaContablePedido(pedida, hoy);
    if ('error' in fecha) throw new BadRequestException('La fecha de la liquidación no puede ser futura');
    const ultimoPedido = libres
      .map((s) => s.platform?.accountingDate ?? fechaColombia((s as unknown as { createdAt?: Date }).createdAt))
      .sort()
      .reverse()[0]!;
    if (pedida < ultimoPedido) {
      throw new BadRequestException(
        `La liquidación no puede ser anterior al pedido más reciente que cobra (${ultimoPedido})`,
      );
    }
    const date = fecha.fecha;

    // IVA de la comisión: descontable (2408) solo para el responsable de IVA;
    // para quien no lo es o causa INC es mayor valor del gasto (arts. 437 y 488 ET).
    const ivaDescontable =
      commissionIva > 0 &&
      admiteIvaDescontable(
        await perfilFiscalDeSede(
          { sedes: this.sedeModel, businesses: this.businesses },
          dto.sedeId,
        ),
      );

    const settlement = await this.settlementModel.create({
      platform: dto.platform,
      sedeId,
      saleIds: ids,
      gross,
      received,
      commission,
      commissionIva,
      ivaDescontable,
      retefuente,
      reteIca,
      reteIva,
      ajustePrecio,
      date,
      note: dto.note?.trim() || undefined,
      status: 'active',
      createdByEmail: user.email,
    });

    // Reserva atómica de los pedidos. Si otra liquidación se adelantó con alguno,
    // modifiedCount queda corto: se suelta lo propio y se aborta antes del libro.
    const reserva = await this.saleModel
      .updateMany(
        {
          _id: { $in: ids },
          sedeId,
          status: 'completed',
          'platform.code': dto.platform,
          'platform.settlementId': { $exists: false },
        },
        { $set: { 'platform.settlementId': settlement._id } },
      )
      .exec();
    if (reserva.modifiedCount !== ids.length) {
      try {
        await this.liberar(settlement._id);
        await this.settlementModel.deleteOne({ _id: settlement._id }).exec();
      } catch {
        // No se pudo soltar: la liquidación queda en `voiding` para que anularla
        // termine el trabajo; borrarla dejaría pedidos apuntando a la nada.
        await this.settlementModel
          .updateOne({ _id: settlement._id }, { $set: { status: 'voiding' } })
          .exec();
        throw new InternalServerErrorException(
          'No se pudo completar la liquidación y quedaron pedidos reservados: anula la liquidación pendiente para liberarlos.',
        );
      }
      throw new ConflictException(
        'Algún pedido cambió mientras liquidabas (se liquidó o se anuló). Revisa la lista e intenta de nuevo.',
      );
    }

    // El asiento es best-effort e idempotente: si falla, `safePost` deja el
    // CONCILIAR en el log y el pendiente del libro (igual que el resto).
    await this.ledgerPosting.postPlatformSettlement({
      settlementId: settlement._id.toString(),
      platformLabel: PLATFORM_LABELS[dto.platform],
      date,
      sedeId: dto.sedeId,
      gross,
      received,
      commission,
      commissionIva,
      ivaDescontable,
      retefuente,
      reteIca,
      reteIva,
      ajustePrecio,
      userEmail: user.email,
    });
    // Lo consignado entra a la cuenta bancaria mapeada a transferencias.
    await this.treasury.post({
      sourceType: 'platform_settlement',
      sourceId: settlement._id.toString(),
      sedeId: dto.sedeId,
      method: 'transfer',
      direction: 'in',
      amount: received,
      date,
      concept: `Liquidación ${PLATFORM_LABELS[dto.platform]}`,
    });
    return settlement;
  }

  /**
   * Anula una liquidación (error de digitación, consignación que no llegó):
   * contra-asiento, saca el movimiento de tesorería y devuelve los pedidos a
   * «por cobrar». Reintentable: si un paso falla queda en `voiding` y los
   * pedidos NO se liberan hasta que la reversa del libro haya ocurrido.
   */
  async void(id: string, user: JwtUser): Promise<PlatformSettlementDocument> {
    const existing = await this.getOrFail(id);
    assertSedeAccess(user, existing.sedeId.toString());
    // Toma atómica: solo una anulación gana (o se reintenta una a medias).
    const tomada = await this.settlementModel
      .findOneAndUpdate(
        { _id: existing._id, status: { $in: ['active', 'voiding'] } },
        {
          $set: { status: 'voiding', voidedByEmail: user.email, voidedAt: new Date() },
        },
        { new: true },
      )
      .exec();
    if (!tomada) throw new BadRequestException('La liquidación ya está anulada');

    try {
      // Estricta: si el libro no se reversa, los pedidos siguen liquidados.
      await this.ledgerPosting.reversePlatformSettlement(tomada._id.toString(), user.email);
      await this.treasury.reverse('platform_settlement', tomada._id.toString());
      await this.liberar(tomada._id);
    } catch (err) {
      this.logger.error(
        `CONCILIAR: la anulación de la liquidación ${tomada._id.toString()} quedó a medias: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        'No se pudo terminar de anular la liquidación (queda en proceso de anulación y los pedidos siguen liquidados). Reintenta.',
      );
    }
    const anulada = await this.settlementModel
      .findOneAndUpdate({ _id: tomada._id }, { $set: { status: 'void' } }, { new: true })
      .exec();
    return anulada ?? tomada;
  }

  /** Suelta los pedidos reservados por una liquidación. */
  private async liberar(settlementId: Types.ObjectId): Promise<void> {
    await this.saleModel
      .updateMany(
        { 'platform.settlementId': settlementId },
        { $unset: { 'platform.settlementId': '' } },
      )
      .exec();
  }

  async getOrFail(id: string): Promise<PlatformSettlementDocument> {
    const doc = Types.ObjectId.isValid(id) ? await this.settlementModel.findById(id).exec() : null;
    if (!doc) throw new NotFoundException('Liquidación no encontrada');
    return doc;
  }

  async list(q: { sedeId: string; platform?: PlatformCode }, user: JwtUser) {
    assertSedeAccess(user, q.sedeId);
    return this.settlementModel
      .find({
        sedeId: new Types.ObjectId(q.sedeId),
        ...(q.platform ? { platform: q.platform } : {}),
      })
      .sort({ date: -1, createdAt: -1 })
      .limit(100)
      .exec();
  }
}
