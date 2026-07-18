import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  StockItem,
  StockItemDocument,
} from '../infrastructure/schemas/stock-item.schema';
import {
  StockLot,
  StockLotDocument,
} from '../infrastructure/schemas/stock-lot.schema';
import {
  StockMovement,
  StockMovementDocument,
} from '../infrastructure/schemas/stock-movement.schema';
import { ProductDocument } from '../infrastructure/schemas/product.schema';
import { ProductsService } from './products.service';
import { StockEntryDto } from './dto/stock-entry.dto';
import { StockAdjustDto } from './dto/stock-adjust.dto';
import { StockTransferDto } from './dto/stock-transfer.dto';
import {
  MovementType,
  WASTE_REASONS,
} from '../domain/inventory.constants';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

interface ConsumedPortion {
  lot?: StockLotDocument;
  qty: number;
}

@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  constructor(
    @InjectModel(StockItem.name)
    private readonly stockItemModel: Model<StockItemDocument>,
    @InjectModel(StockLot.name)
    private readonly lotModel: Model<StockLotDocument>,
    @InjectModel(StockMovement.name)
    private readonly movementModel: Model<StockMovementDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly products: ProductsService,
  ) {}

  /**
   * Ejecuta `fn` dentro de una transacción. Si el servidor de Mongo no las
   * soporta (standalone sin replica set), reintenta sin sesión para no
   * bloquear entornos de desarrollo.
   */
  private async withTransaction<T>(
    fn: (session?: ClientSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.connection.transaction((session) => fn(session));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/replica set|transaction numbers|retryable writes/i.test(message)) {
        this.logger.warn(
          'MongoDB sin soporte de transacciones; ejecutando sin sesión',
        );
        return fn(undefined);
      }
      throw err;
    }
  }

  // ─── Entradas ──────────────────────────────────────────────────────────────

  async entry(dto: StockEntryDto, user: JwtUser) {
    const product = await this.products.getOrFail(dto.productId);
    if (!product.active) {
      throw new BadRequestException('El producto está inactivo');
    }
    if (product.perishable && !dto.expiresAt) {
      throw new BadRequestException(
        'Un producto perecedero requiere fecha de vencimiento en la entrada',
      );
    }
    const sedeId = new Types.ObjectId(dto.sedeId);
    const unitCost = dto.unitCost ?? product.cost ?? 0;

    return this.withTransaction(async (session) => {
      const item = await this.stockItemModel
        .findOneAndUpdate(
          { productId: product._id, sedeId },
          { $inc: { qty: dto.qty } },
          { upsert: true, new: true, session },
        )
        .exec();

      let lot: StockLotDocument | undefined;
      if (product.trackLots) {
        const [created] = await this.lotModel.create(
          [
            {
              productId: product._id,
              sedeId,
              lotCode: dto.lotCode?.trim() || this.generateLotCode(),
              expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
              qty: dto.qty,
              initialQty: dto.qty,
              unitCost,
              receivedAt: new Date(),
            },
          ],
          { session },
        );
        lot = created;
      }

      const [movement] = await this.movementModel.create(
        [
          {
            type: 'entry' satisfies MovementType,
            productId: product._id,
            sedeId,
            lotId: lot?._id,
            delta: dto.qty,
            balanceAfter: item.qty,
            unitCost,
            note: dto.note,
            userId: user.userId,
            userEmail: user.email,
          },
        ],
        { session },
      );

      // Último costo de compra como referencia del producto.
      if (dto.unitCost !== undefined && dto.unitCost !== product.cost) {
        product.cost = dto.unitCost;
        await product.save({ session });
      }

      return { item, lot, movement };
    });
  }

  // ─── Ajustes y mermas ──────────────────────────────────────────────────────

  async adjust(dto: StockAdjustDto, user: JwtUser) {
    const product = await this.products.getOrFail(dto.productId);
    const sedeId = new Types.ObjectId(dto.sedeId);

    if (dto.direction === 'add') {
      return this.withTransaction(async (session) => {
        const item = await this.stockItemModel
          .findOneAndUpdate(
            { productId: product._id, sedeId },
            { $inc: { qty: dto.qty } },
            { upsert: true, new: true, session },
          )
          .exec();

        let lot: StockLotDocument | undefined;
        if (product.trackLots) {
          const [created] = await this.lotModel.create(
            [
              {
                productId: product._id,
                sedeId,
                lotCode: this.generateLotCode('AJ'),
                qty: dto.qty,
                initialQty: dto.qty,
                unitCost: product.cost ?? 0,
                receivedAt: new Date(),
              },
            ],
            { session },
          );
          lot = created;
        }

        const [movement] = await this.movementModel.create(
          [
            {
              type: 'adjust_in' satisfies MovementType,
              productId: product._id,
              sedeId,
              lotId: lot?._id,
              delta: dto.qty,
              balanceAfter: item.qty,
              reason: dto.reason,
              note: dto.note,
              userId: user.userId,
              userEmail: user.email,
            },
          ],
          { session },
        );
        return { item, movement };
      });
    }

    // direction === 'remove': merma o ajuste negativo, consumiendo lotes FEFO.
    const type: MovementType = WASTE_REASONS.includes(dto.reason)
      ? 'waste'
      : 'adjust_out';

    return this.withTransaction(async (session) => {
      const { item, portions } = await this.consume(
        product,
        sedeId,
        dto.qty,
        session,
        dto.lotId,
      );
      const movements = await this.recordExits(
        type,
        product,
        sedeId,
        item,
        portions,
        session,
        { reason: dto.reason, note: dto.note, user },
      );
      return { item, movements };
    });
  }

  // ─── Traslados entre sedes ─────────────────────────────────────────────────

  async transfer(dto: StockTransferDto, user: JwtUser) {
    if (dto.fromSedeId === dto.toSedeId) {
      throw new BadRequestException(
        'La sede de origen y destino deben ser distintas',
      );
    }
    const product = await this.products.getOrFail(dto.productId);
    const fromSedeId = new Types.ObjectId(dto.fromSedeId);
    const toSedeId = new Types.ObjectId(dto.toSedeId);
    const transferGroupId = new Types.ObjectId().toString();

    return this.withTransaction(async (session) => {
      // 1. Salida en la sede de origen (FEFO).
      const { item: fromItem, portions } = await this.consume(
        product,
        fromSedeId,
        dto.qty,
        session,
      );
      await this.recordExits(
        'transfer_out',
        product,
        fromSedeId,
        fromItem,
        portions,
        session,
        { note: dto.note, user, transferGroupId },
      );

      // 2. Entrada en la sede destino, conservando lote y vencimiento.
      const toItem = await this.stockItemModel
        .findOneAndUpdate(
          { productId: product._id, sedeId: toSedeId },
          { $inc: { qty: dto.qty } },
          { upsert: true, new: true, session },
        )
        .exec();

      let balance = toItem.qty - dto.qty;
      for (const portion of portions) {
        let destLot: StockLotDocument | undefined;
        if (portion.lot) {
          // Si en destino ya existe el mismo lote (código + vencimiento), se suma.
          destLot =
            (await this.lotModel
              .findOneAndUpdate(
                {
                  productId: product._id,
                  sedeId: toSedeId,
                  lotCode: portion.lot.lotCode,
                  expiresAt: portion.lot.expiresAt ?? null,
                },
                { $inc: { qty: portion.qty, initialQty: portion.qty } },
                { new: true, session },
              )
              .exec()) ?? undefined;
          if (!destLot) {
            const [created] = await this.lotModel.create(
              [
                {
                  productId: product._id,
                  sedeId: toSedeId,
                  lotCode: portion.lot.lotCode,
                  expiresAt: portion.lot.expiresAt,
                  qty: portion.qty,
                  initialQty: portion.qty,
                  unitCost: portion.lot.unitCost,
                  receivedAt: new Date(),
                },
              ],
              { session },
            );
            destLot = created;
          }
        }
        balance += portion.qty;
        await this.movementModel.create(
          [
            {
              type: 'transfer_in' satisfies MovementType,
              productId: product._id,
              sedeId: toSedeId,
              lotId: destLot?._id,
              delta: portion.qty,
              balanceAfter: balance,
              unitCost: portion.lot?.unitCost,
              note: dto.note,
              transferGroupId,
              userId: user.userId,
              userEmail: user.email,
            },
          ],
          { session },
        );
      }

      return { fromItem, toItem, transferGroupId };
    });
  }

  // ─── Consultas ─────────────────────────────────────────────────────────────

  /** Existencias consolidadas (opcionalmente filtradas por sede). */
  async stock(sedeId?: string) {
    const filter = sedeId ? { sedeId: new Types.ObjectId(sedeId) } : {};
    const items = await this.stockItemModel
      .find(filter)
      .populate('productId')
      .populate('sedeId', 'code name')
      .sort({ updatedAt: -1 })
      .exec();

    // Resumen de lotes vigentes por producto+sede para vencimientos.
    const lotFilter: Record<string, unknown> = { qty: { $gt: 0 } };
    if (sedeId) lotFilter.sedeId = new Types.ObjectId(sedeId);
    const lotSummary = await this.lotModel.aggregate<{
      _id: { productId: Types.ObjectId; sedeId: Types.ObjectId };
      lotCount: number;
      nextExpiresAt: Date | null;
    }>([
      { $match: lotFilter },
      {
        $group: {
          _id: { productId: '$productId', sedeId: '$sedeId' },
          lotCount: { $sum: 1 },
          nextExpiresAt: { $min: '$expiresAt' },
        },
      },
    ]);
    const summaryMap = new Map(
      lotSummary.map((s) => [
        `${s._id.productId.toString()}:${s._id.sedeId.toString()}`,
        s,
      ]),
    );

    return items
      .filter((item) => item.productId) // producto borrado físicamente
      .map((item) => {
        const product = item.productId as unknown as ProductDocument;
        const key = `${product._id.toString()}:${(
          item.sedeId as unknown as { _id: Types.ObjectId }
        )._id.toString()}`;
        const summary = summaryMap.get(key);
        return {
          id: item._id.toString(),
          product,
          sede: item.sedeId,
          qty: item.qty,
          minStock: item.minStock ?? product.minStock ?? 0,
          lotCount: summary?.lotCount ?? 0,
          nextExpiresAt: summary?.nextExpiresAt ?? null,
        };
      });
  }

  /** Lotes vigentes de un producto (FEFO). */
  async lots(productId: string, sedeId?: string) {
    if (!Types.ObjectId.isValid(productId)) {
      throw new NotFoundException('Producto no encontrado');
    }
    const filter: Record<string, unknown> = {
      productId: new Types.ObjectId(productId),
      qty: { $gt: 0 },
    };
    if (sedeId) filter.sedeId = new Types.ObjectId(sedeId);
    const lots = await this.lotModel
      .find(filter)
      .populate('sedeId', 'code name')
      .exec();
    return this.sortFefo(lots);
  }

  /** Kardex paginado. */
  async movements(query: {
    sedeId?: string;
    productId?: string;
    type?: string;
    page?: number;
    limit?: number;
  }) {
    const filter: Record<string, unknown> = {};
    if (query.sedeId) filter.sedeId = new Types.ObjectId(query.sedeId);
    if (query.productId) filter.productId = new Types.ObjectId(query.productId);
    if (query.type) filter.type = query.type;

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const page = Math.max(query.page ?? 1, 1);

    const [total, rows] = await Promise.all([
      this.movementModel.countDocuments(filter).exec(),
      this.movementModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('productId', 'sku name unit')
        .populate('sedeId', 'code name')
        .populate('lotId', 'lotCode expiresAt')
        .exec(),
    ]);

    return { total, page, limit, rows };
  }

  /** Alertas: stock bajo + lotes vencidos o por vencer. */
  async alerts(sedeId?: string, days = 7) {
    const [stock, expiringLots] = await Promise.all([
      this.stock(sedeId),
      (async () => {
        const limitDate = new Date();
        limitDate.setDate(limitDate.getDate() + days);
        const filter: Record<string, unknown> = {
          qty: { $gt: 0 },
          expiresAt: { $lte: limitDate },
        };
        if (sedeId) filter.sedeId = new Types.ObjectId(sedeId);
        return this.lotModel
          .find(filter)
          .sort({ expiresAt: 1 })
          .populate('productId', 'sku name unit perishable')
          .populate('sedeId', 'code name')
          .exec();
      })(),
    ]);

    const now = new Date();
    const lowStock = stock.filter(
      (s) => s.minStock > 0 && s.qty <= s.minStock && s.product.active,
    );
    const expired = expiringLots.filter((l) => l.expiresAt! < now);
    const expiringSoon = expiringLots.filter((l) => l.expiresAt! >= now);

    return { lowStock, expired, expiringSoon, days };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private generateLotCode(prefix = 'L'): string {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${prefix}-${ymd}-${rand}`;
  }

  /** Orden FEFO: primero lo que vence primero; sin vencimiento, al final. */
  private sortFefo(lots: StockLotDocument[]): StockLotDocument[] {
    return [...lots].sort((a, b) => {
      if (a.expiresAt && b.expiresAt) {
        return a.expiresAt.getTime() - b.expiresAt.getTime();
      }
      if (a.expiresAt) return -1;
      if (b.expiresAt) return 1;
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });
  }

  /**
   * Descuenta `qty` del stock de la sede. Si el producto controla lotes,
   * consume FEFO (o el lote indicado) y devuelve las porciones usadas.
   */
  private async consume(
    product: ProductDocument,
    sedeId: Types.ObjectId,
    qty: number,
    session: ClientSession | undefined,
    lotId?: string,
  ): Promise<{ item: StockItemDocument; portions: ConsumedPortion[] }> {
    // Decremento condicional: falla si no hay stock suficiente (protege
    // también frente a operaciones concurrentes).
    const item = await this.stockItemModel
      .findOneAndUpdate(
        { productId: product._id, sedeId, qty: { $gte: qty } },
        { $inc: { qty: -qty } },
        { new: true, session },
      )
      .exec();
    if (!item) {
      const current = await this.stockItemModel
        .findOne({ productId: product._id, sedeId })
        .session(session ?? null)
        .exec();
      throw new BadRequestException(
        `Stock insuficiente de ${product.name}: hay ${current?.qty ?? 0} y se requieren ${qty}`,
      );
    }

    if (!product.trackLots) {
      return { item, portions: [{ qty }] };
    }

    let candidates: StockLotDocument[];
    if (lotId) {
      const lot = await this.lotModel
        .findOne({ _id: lotId, productId: product._id, sedeId })
        .session(session ?? null)
        .exec();
      if (!lot) throw new NotFoundException('Lote no encontrado');
      candidates = [lot];
    } else {
      const open = await this.lotModel
        .find({ productId: product._id, sedeId, qty: { $gt: 0 } })
        .session(session ?? null)
        .exec();
      candidates = this.sortFefo(open);
    }

    const portions: ConsumedPortion[] = [];
    let remaining = qty;
    for (const lot of candidates) {
      if (remaining <= 0) break;
      const take = Math.min(lot.qty, remaining);
      if (take <= 0) continue;
      lot.qty -= take;
      await lot.save({ session });
      portions.push({ lot, qty: take });
      remaining -= take;
    }
    if (remaining > 0) {
      throw new BadRequestException(
        `Los lotes de ${product.name} no cubren la cantidad solicitada (faltan ${remaining}); revisa el inventario por lotes`,
      );
    }
    return { item, portions };
  }

  /** Registra los movimientos de salida (uno por lote consumido). */
  private async recordExits(
    type: MovementType,
    product: ProductDocument,
    sedeId: Types.ObjectId,
    item: StockItemDocument,
    portions: ConsumedPortion[],
    session: ClientSession | undefined,
    meta: {
      reason?: string;
      note?: string;
      transferGroupId?: string;
      user: JwtUser;
    },
  ): Promise<StockMovementDocument[]> {
    const totalOut = portions.reduce((sum, p) => sum + p.qty, 0);
    let balance = item.qty + totalOut; // saldo antes de la salida
    const movements: StockMovementDocument[] = [];
    for (const portion of portions) {
      balance -= portion.qty;
      const created = await this.movementModel.create(
        [
          {
            type,
            productId: product._id,
            sedeId,
            lotId: portion.lot?._id,
            delta: -portion.qty,
            balanceAfter: balance,
            unitCost: portion.lot?.unitCost,
            reason: meta.reason,
            note: meta.note,
            transferGroupId: meta.transferGroupId,
            userId: meta.user.userId,
            userEmail: meta.user.email,
          },
        ],
        { session },
      );
      movements.push(...created);
    }
    return movements;
  }
}
