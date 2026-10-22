import {
  BadRequestException,
  ConflictException,
  Injectable,
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
import { CreatePlatformSettlementDto } from './dto/platform-orders.dto';
import {
  PLATFORM_LABELS,
  PlatformCode,
  platformReceivable,
  validateSettlement,
} from '../domain/platform-orders';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { TreasuryPostingService } from '../../finance/treasury/treasury-posting.service';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { cop, sumBy } from '../../finance/domain/money.util';

/**
 * Liquidación de las plataformas de domicilio (ítem 7.5): cuando Rappi, DiDi
 * Food o Uber Eats consignan, se cancela la cuenta por cobrar de los pedidos y
 * se reconoce la comisión como gasto.
 *
 * Orden y garantías (Mongo standalone, sin transacciones):
 *   1. Se crea la liquidación (su id es el `sourceId` del asiento).
 *   2. Se RESERVAN los pedidos con un update condicional (sin liquidar,
 *      completados, de esta sede y plataforma). Si alguno ya no está libre, se
 *      suelta lo reservado y se rechaza: un pedido jamás se cobra dos veces.
 *   3. Asiento (idempotente por origen) y tesorería, ambos best-effort como el
 *      resto del libro.
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
      .select('total deliveryFee')
      .exec();
    if (libres.length !== ids.length) {
      throw new BadRequestException(
        'Algún pedido no es de esta sede y plataforma, está anulado o ya fue liquidado',
      );
    }
    const gross = sumBy(libres, (s) => platformReceivable(s));
    const commission = cop(dto.commission);
    const commissionIva = cop(dto.commissionIva ?? 0);
    const received = cop(dto.received);
    const problema = validateSettlement({ gross, received, commission, commissionIva });
    if (problema) throw new BadRequestException(problema);

    const date = dto.date ?? fechaColombia();
    if (date > fechaColombia()) {
      throw new BadRequestException('La fecha de la liquidación no puede ser futura');
    }

    const settlement = await this.settlementModel.create({
      platform: dto.platform,
      sedeId,
      saleIds: ids,
      gross,
      received,
      commission,
      commissionIva,
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
      await this.liberar(settlement._id);
      await this.settlementModel.deleteOne({ _id: settlement._id }).exec();
      throw new ConflictException(
        'Algún pedido cambió mientras liquidabas (se liquidó o se anuló). Revisa la lista e intenta de nuevo.',
      );
    }

    const sedeStr = dto.sedeId;
    await this.ledgerPosting.postPlatformSettlement({
      settlementId: settlement._id.toString(),
      platformLabel: PLATFORM_LABELS[dto.platform],
      date,
      sedeId: sedeStr,
      gross,
      received,
      commission,
      commissionIva,
      userEmail: user.email,
    });
    // Lo consignado entra a la cuenta bancaria mapeada a transferencias.
    await this.treasury.post({
      sourceType: 'platform_settlement',
      sourceId: settlement._id.toString(),
      sedeId: sedeStr,
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
   * «por cobrar». La liquidación queda `void` para la auditoría.
   */
  async void(id: string, user: JwtUser): Promise<PlatformSettlementDocument> {
    const existing = await this.getOrFail(id);
    assertSedeAccess(user, existing.sedeId.toString());
    // Toma atómica: solo una anulación gana.
    const tomada = await this.settlementModel
      .findOneAndUpdate(
        { _id: existing._id, status: 'active' },
        { $set: { status: 'void', voidedByEmail: user.email, voidedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!tomada) throw new BadRequestException('La liquidación ya está anulada');

    await this.ledgerPosting.reversePlatformSettlement(tomada._id.toString(), user.email);
    await this.treasury.reverse('platform_settlement', tomada._id.toString());
    await this.liberar(tomada._id);
    return tomada;
  }

  /** Suelta los pedidos reservados por una liquidación. */
  private async liberar(settlementId: Types.ObjectId): Promise<void> {
    try {
      await this.saleModel
        .updateMany(
          { 'platform.settlementId': settlementId },
          { $unset: { 'platform.settlementId': '' } },
        )
        .exec();
    } catch (err) {
      this.logger.error(
        `CONCILIAR: no se pudieron liberar los pedidos de la liquidación ${settlementId.toString()}: ${(err as Error).message}`,
      );
      throw err;
    }
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
