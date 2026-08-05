import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { TenantModelRegistry } from '../../../shared/tenancy/tenant-model.registry';
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
import { SedesService } from '../../sedes/application/sedes.service';
import { StockEntryDto } from './dto/stock-entry.dto';
import { StockAdjustDto } from './dto/stock-adjust.dto';
import { StockTransferDto } from './dto/stock-transfer.dto';
import {
  MovementType,
  WASTE_REASONS,
} from '../domain/inventory.constants';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';

export interface ConsumedPortion {
  lot?: StockLotDocument;
  qty: number;
}

/** Línea de venta a descontar del stock de una sede. */
export interface SaleLineInput {
  productId: string;
  qty: number;
}

/** Resultado del descuento de una línea vendida (para derivar costos). */
export interface SoldLine {
  product: ProductDocument;
  portions: ConsumedPortion[];
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
    private readonly tenant: TenantModelRegistry,
    private readonly products: ProductsService,
    private readonly sedes: SedesService,
  ) {}

  /**
   * Ejecuta `fn` dentro de una transacción. Si el servidor de Mongo no las
   * soporta (standalone sin replica set), reintenta sin sesión para no
   * bloquear entornos de desarrollo.
   */
  private async withTransaction<T>(
    fn: (session?: ClientSession) => Promise<T>,
  ): Promise<T> {
    // Conexión a la base de la empresa activa: la transacción y los modelos
    // (proxies) operan sobre la MISMA base (useCache reutiliza la conexión).
    const connection = this.tenant.connectionFor();
    try {
      return await connection.transaction((session) => fn(session));
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
    assertSedeAccess(user, dto.sedeId);
    const product = await this.products.getOrFail(dto.productId);
    if (!product.active) {
      throw new BadRequestException('El producto está inactivo');
    }
    if (product.perishable && !dto.expiresAt) {
      throw new BadRequestException(
        'Un producto perecedero requiere fecha de vencimiento en la entrada',
      );
    }
    await this.sedes.findOrFail(dto.sedeId);
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
              // Sin proveedor en la entrada, hereda el habitual del producto.
              supplier: dto.supplier?.trim() || product.supplier || undefined,
              supplierId: dto.supplierId
                ? new Types.ObjectId(dto.supplierId)
                : (product.supplierId ?? undefined),
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
    assertSedeAccess(user, dto.sedeId);
    const product = await this.products.getOrFail(dto.productId);
    await this.sedes.findOrFail(dto.sedeId);
    const sedeId = new Types.ObjectId(dto.sedeId);

    if (dto.direction === 'add') {
      // Un perecedero no puede entrar sin vencimiento (rompería el FEFO).
      if (product.perishable && !dto.expiresAt) {
        throw new BadRequestException(
          'Un ajuste positivo de un producto perecedero requiere fecha de vencimiento',
        );
      }
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
                lotCode: dto.lotCode?.trim() || this.generateLotCode('AJ'),
                expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
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
    // El usuario debe tener acceso a ambas sedes del traslado.
    assertSedeAccess(user, dto.fromSedeId);
    assertSedeAccess(user, dto.toSedeId);
    const product = await this.products.getOrFail(dto.productId);
    await this.sedes.findOrFail(dto.fromSedeId);
    await this.sedes.findOrFail(dto.toSedeId);
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
                  supplier: portion.lot.supplier,
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

  // ─── Ventas (POS) ──────────────────────────────────────────────────────────

  /**
   * Descuenta del stock de la sede las líneas de una venta, consumiendo
   * lotes FEFO y registrando movimientos tipo 'sale'. Falla completa si
   * alguna línea no tiene stock suficiente.
   */
  async sell(
    sedeId: string,
    lines: SaleLineInput[],
    user: JwtUser,
  ): Promise<SoldLine[]> {
    await this.sedes.findOrFail(sedeId);
    const sede = new Types.ObjectId(sedeId);
    const items = await Promise.all(
      lines.map(async (l) => ({
        product: await this.products.getOrFail(l.productId),
        qty: l.qty,
      })),
    );

    return this.withTransaction(async (session) => {
      const sold: SoldLine[] = [];
      for (const { product, qty } of items) {
        const { item, portions } = await this.consume(
          product,
          sede,
          qty,
          session,
        );
        await this.recordExits('sale', product, sede, item, portions, session, {
          user,
        });
        sold.push({ product, portions });
      }
      return sold;
    });
  }

  /**
   * Reversa el consumo de una venta anulada: devuelve cada componente al stock
   * de la sede, restaura los lotes consumidos y registra movimientos
   * 'sale_void'. Es idempotente por venta a nivel de negocio (el llamador marca
   * la venta como 'void' para no reversarla dos veces).
   */
  async reverseSale(
    sedeId: string,
    units: {
      productId: string;
      qty: number;
      consumedLots: { lotId?: string; qty: number; unitCost?: number }[];
    }[],
    user: JwtUser,
  ): Promise<void> {
    const sede = new Types.ObjectId(sedeId);
    // Cargar productos fuera de la transacción (falla claro si alguno ya no existe).
    const loaded = await Promise.all(
      units.map(async (u) => ({
        product: await this.products.getOrFail(u.productId),
        qty: u.qty,
        consumedLots: u.consumedLots,
      })),
    );

    await this.withTransaction(async (session) => {
      for (const { product, qty, consumedLots } of loaded) {
        const item = await this.stockItemModel
          .findOneAndUpdate(
            { productId: product._id, sedeId: sede },
            { $inc: { qty } },
            { upsert: true, new: true, session },
          )
          .exec();

        // Reparte la devolución en las porciones de lote consumidas; si no había
        // lotes (producto sin trackLots), una sola porción por el total.
        const portions =
          consumedLots.length > 0 ? consumedLots : [{ qty, unitCost: undefined }];
        let balance = item.qty - qty; // saldo antes de la devolución
        for (const portion of portions) {
          if (portion.lotId) {
            await this.lotModel
              .updateOne(
                { _id: new Types.ObjectId(portion.lotId) },
                { $inc: { qty: portion.qty } },
                { session },
              )
              .exec();
          }
          balance += portion.qty;
          await this.movementModel.create(
            [
              {
                type: 'sale_void' satisfies MovementType,
                productId: product._id,
                sedeId: sede,
                lotId: portion.lotId
                  ? new Types.ObjectId(portion.lotId)
                  : undefined,
                delta: portion.qty,
                balanceAfter: balance,
                unitCost: portion.unitCost,
                note: 'Anulación de venta',
                userId: user.userId,
                userEmail: user.email,
              },
            ],
            { session },
          );
        }
      }
    });
  }

  /**
   * Elimina definitivamente un producto junto con sus existencias, lotes y
   * movimientos de kardex en todas las sedes.
   */
  async removeProduct(productId: string) {
    const product = await this.products.getOrFail(productId);
    const result = await this.withTransaction(async (session) => {
      await this.movementModel
        .deleteMany({ productId: product._id })
        .session(session ?? null)
        .exec();
      await this.lotModel
        .deleteMany({ productId: product._id })
        .session(session ?? null)
        .exec();
      await this.stockItemModel
        .deleteMany({ productId: product._id })
        .session(session ?? null)
        .exec();
      await product.deleteOne({ session });
      return { ok: true };
    });
    // Retira también su vendible automático del POS (fuera de la transacción:
    // el catálogo no participa del arrastre de inventario).
    await this.products.syncCatalogRemoved(product._id);
    return result;
  }

  // ─── Consultas ─────────────────────────────────────────────────────────────

  /** Existencias consolidadas (opcionalmente filtradas por sede). */
  async stock(sedeId?: string, restrict?: string[] | null) {
    const sedeMatch = this.sedeMatch(sedeId, restrict);
    const filter = sedeMatch ?? {};
    const items = await this.stockItemModel
      .find(filter)
      // Anidado: la UI muestra la categoría del producto en existencias.
      .populate({
        path: 'productId',
        populate: { path: 'categoryId', select: 'name' },
      })
      .populate('sedeId', 'code name')
      .sort({ updatedAt: -1 })
      .exec();

    // Resumen de lotes vigentes por producto+sede para vencimientos y valor.
    // `value` = Σ (qty × unitCost) del lote: costo real de lo que hay en bodega.
    const lotFilter: Record<string, unknown> = { qty: { $gt: 0 }, ...sedeMatch };
    const lotSummary = await this.lotModel.aggregate<{
      _id: { productId: Types.ObjectId; sedeId: Types.ObjectId };
      lotCount: number;
      nextExpiresAt: Date | null;
      value: number;
    }>([
      { $match: lotFilter },
      {
        $group: {
          _id: { productId: '$productId', sedeId: '$sedeId' },
          lotCount: { $sum: 1 },
          nextExpiresAt: { $min: '$expiresAt' },
          value: { $sum: { $multiply: ['$qty', '$unitCost'] } },
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
      // Descarta referencias huérfanas (producto o sede borrados físicamente).
      .filter((item) => item.productId && item.sedeId)
      .map((item) => {
        const product = item.productId as unknown as ProductDocument;
        const key = `${product._id.toString()}:${(
          item.sedeId as unknown as { _id: Types.ObjectId }
        )._id.toString()}`;
        const summary = summaryMap.get(key);
        // Valor a costo real: si hay lotes, suma su (qty × unitCost); si el
        // producto no maneja lotes, se aproxima con qty × costo del producto.
        const value = summary
          ? summary.value
          : item.qty * (product.cost ?? 0);
        return {
          id: item._id.toString(),
          product,
          sede: item.sedeId,
          qty: item.qty,
          minStock: item.minStock ?? product.minStock ?? 0,
          lotCount: summary?.lotCount ?? 0,
          nextExpiresAt: summary?.nextExpiresAt ?? null,
          value,
        };
      });
  }

  /** Lotes vigentes de un producto (FEFO). */
  async lots(productId: string, sedeId?: string, restrict?: string[] | null) {
    if (!Types.ObjectId.isValid(productId)) {
      throw new NotFoundException('Producto no encontrado');
    }
    const filter: Record<string, unknown> = {
      productId: new Types.ObjectId(productId),
      qty: { $gt: 0 },
      ...this.sedeMatch(sedeId, restrict),
    };
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
    restrict?: string[] | null;
  }) {
    const filter: Record<string, unknown> = {
      ...this.sedeMatch(query.sedeId, query.restrict),
    };
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
  async alerts(sedeId?: string, days = 7, restrict?: string[] | null) {
    const [stock, expiringLots] = await Promise.all([
      this.stock(sedeId, restrict),
      (async () => {
        const limitDate = new Date();
        limitDate.setDate(limitDate.getDate() + days);
        const filter: Record<string, unknown> = {
          qty: { $gt: 0 },
          expiresAt: { $lte: limitDate },
          ...this.sedeMatch(sedeId, restrict),
        };
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

  /**
   * Construye el match por sede: una sede concreta, o `{ $in }` con las sedes
   * permitidas del usuario (aislamiento), o `null` si no hay restricción.
   */
  private sedeMatch(
    sedeId?: string,
    restrict?: string[] | null,
  ): Record<string, unknown> | null {
    if (sedeId) return { sedeId: new Types.ObjectId(sedeId) };
    if (restrict) {
      return {
        sedeId: { $in: restrict.map((id) => new Types.ObjectId(id)) },
      };
    }
    return null;
  }

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
