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
import { Product, ProductDocument } from '../infrastructure/schemas/product.schema';
import { ProductCategory } from '../infrastructure/schemas/product-category.schema';
import { Sede } from '../../sedes/infrastructure/schemas/sede.schema';
import { ProductsService } from './products.service';
import { SedesService } from '../../sedes/application/sedes.service';
import { StockEntryDto } from './dto/stock-entry.dto';
import { StockAdjustDto } from './dto/stock-adjust.dto';
import {
  StockCountDto,
  StockCountResult,
} from './dto/stock-count.dto';
import { StockTransferDto } from './dto/stock-transfer.dto';
import {
  ImportStockRow,
  ImportStockResult,
} from './dto/import-stock.dto';
import {
  MovementType,
  WASTE_REASONS,
} from '../domain/inventory.constants';
import {
  packsToStockQty,
  unitCostFromPack,
} from '../domain/purchase-unit';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { cop } from '../../finance/domain/money.util';

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

/**
 * Los mismos tipos con nombre neutral: consumir stock no siempre es vender
 * (producción transforma). Se declaran como alias para no duplicar la forma ni
 * obligar al módulo de producción a hablar de "ventas".
 */
export type ConsumeLineInput = SaleLineInput;
export type ConsumedLine = SoldLine;

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
    /**
     * Modelos referenciados por `populate`. Van EXPLÍCITOS en cada populate
     * porque los modelos se compilan de forma perezosa sobre la base de cada
     * empresa: si el referenciado todavía no lo estaba, mongoose lanzaba
     * MissingSchemaError y la pantalla salía en 500 hasta que otra petición lo
     * compilara. Se declaran al final para no mover el orden de los parámetros
     * ya existentes (varias pruebas construyen el servicio posicionalmente).
     */
    @InjectModel(Product.name)
    private readonly productModel: Model<unknown>,
    @InjectModel(ProductCategory.name)
    private readonly categoryModel: Model<unknown>,
    @InjectModel(Sede.name)
    private readonly sedeModel: Model<unknown>,
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

  /**
   * Ingresa mercancía a una sede.
   *
   * `opts.movementType` existe para que quien produce (o cualquier flujo que
   * NO sea una compra) quede identificado en el kardex sin duplicar los ~60
   * renglones de esta función. Por omisión es 'entry', que es lo que registra
   * una recepción de proveedor.
   */
  async entry(
    dto: StockEntryDto,
    user: JwtUser,
    opts: { movementType?: MovementType } = {},
  ) {
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

    // La mercancía llega como la despacha el proveedor —3 bultos de harina—,
    // no en la unidad en que se consume. Si la entrada viene marcada así, la
    // cantidad se multiplica por el factor del producto (75.000 g) y el precio
    // del bulto se reexpresa por gramo. La conversión se hace AQUÍ y no en la
    // pantalla: es la misma cuenta para la recepción, el POS y lo que venga
    // después, y tenerla repetida en cada pantalla fue justo lo que obligó a
    // poner un parche que adivinaba la unidad de compra.
    if (dto.inPurchaseUnits && !product.purchaseFactor) {
      throw new BadRequestException(
        `${product.name} no tiene definida una presentación de compra`,
      );
    }
    const factor = dto.inPurchaseUnits ? product.purchaseFactor : undefined;
    const qty = packsToStockQty(dto.qty, factor);
    // Se guarda aparte del costo efectivo porque abajo decide si el producto
    // actualiza su "último costo de compra": solo cuando el usuario lo digitó.
    const enteredCost =
      dto.unitCost !== undefined
        ? unitCostFromPack(dto.unitCost, factor)
        : undefined;
    const unitCost = enteredCost ?? product.cost ?? 0;

    return this.withTransaction(async (session) => {
      const item = await this.stockItemModel
        .findOneAndUpdate(
          { productId: product._id, sedeId },
          { $inc: { qty } },
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
              qty,
              initialQty: qty,
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
            type: opts.movementType ?? ('entry' satisfies MovementType),
            productId: product._id,
            sedeId,
            lotId: lot?._id,
            delta: qty,
            balanceAfter: item.qty,
            unitCost,
            note: dto.note,
            userId: user.userId,
            userEmail: user.email,
          },
        ],
        { session },
      );

      // Último costo de compra como referencia del producto, ya por unidad de
      // consumo: si vino el precio del bulto, lo que se guarda es el del gramo.
      if (enteredCost !== undefined && enteredCost !== product.cost) {
        product.cost = enteredCost;
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

  /**
   * Aplica un conteo físico: la planilla que se llena recorriendo la bodega.
   *
   * No suma ni resta lo que le digan — DEJA la existencia en lo contado. El
   * estante es la verdad; la diferencia contra lo que el sistema creía es el
   * ajuste, y puede salir para cualquier lado. Esa es toda la diferencia con
   * `importStock`, que suma cada fila como entrada: usar aquello para contar
   * duplica el inventario, que es exactamente lo que pasaba hasta hoy.
   *
   * Reutiliza `adjust` con razón `conteo`, así que el kardex, los lotes, el
   * FEFO y el control de acceso por sede salen gratis y con el mismo
   * comportamiento que un ajuste hecho a mano. Sale una transacción por
   * producto en vez de una sola grande: es más lento, pero un producto que
   * falle no puede tumbar el conteo entero, y un conteo se hace una vez a la
   * semana con la persiana abajo.
   *
   * Cada fila es independiente: lo que no se pueda ajustar se reporta con su
   * motivo y el resto del conteo se aplica igual.
   */
  async applyCount(
    dto: StockCountDto,
    user: JwtUser,
  ): Promise<StockCountResult> {
    assertSedeAccess(user, dto.sedeId);
    await this.sedes.findOrFail(dto.sedeId);
    const sedeId = new Types.ObjectId(dto.sedeId);

    const result: StockCountResult = {
      total: dto.rows.length,
      adjusted: 0,
      unchanged: 0,
      addedQty: 0,
      removedQty: 0,
      addedValue: 0,
      removedValue: 0,
      moved: [],
      errors: [],
    };

    const note = dto.note?.trim() || 'Conteo físico';

    for (const row of dto.rows) {
      let nombre = row.productId;
      try {
        const product = await this.products.getOrFail(row.productId);
        nombre = product.name;

        // La existencia se lee AHORA, no cuando se generó la planilla: entre
        // una cosa y otra pudo venderse algo. Un producto que nunca ha entrado
        // a esta sede no tiene fila de existencias todavía, y eso es un cero
        // legítimo —puede aparecer en el estante y hay que registrarlo—.
        const item = await this.stockItemModel
          .findOne({ productId: product._id, sedeId })
          .exec();
        const actual = item?.qty ?? 0;

        if (row.expected !== undefined && row.expected !== actual) {
          result.moved.push({
            productId: row.productId,
            name: product.name,
            expected: row.expected,
            actual,
          });
        }

        const delta = row.counted - actual;
        // Los insumos se miden en gramos: por debajo de esto la diferencia es
        // del redondeo de la balanza, no del inventario.
        if (Math.abs(delta) < 0.0005) {
          result.unchanged += 1;
          continue;
        }

        // Un perecedero que aparece de más necesita saber cuándo vence, o
        // rompería el FEFO. No hay forma de adivinarlo desde una planilla, así
        // que esa fila se devuelve para registrarla como entrada de verdad.
        if (delta > 0 && product.perishable) {
          throw new Error(
            'Apareció de más y es perecedero: regístralo como entrada de mercancía para poder ponerle el vencimiento',
          );
        }

        await this.adjust(
          {
            productId: row.productId,
            sedeId: dto.sedeId,
            direction: delta > 0 ? 'add' : 'remove',
            qty: Math.abs(delta),
            reason: 'conteo',
            note,
          } as StockAdjustDto,
          user,
        );

        result.adjusted += 1;
        // El valor se calcula con el costo del producto y no con el de cada
        // lote: es para que el dueño vea de un vistazo cuánta plata se fue en
        // faltantes, no para contabilizarlo.
        const valor = cop(Math.abs(delta) * (product.cost ?? 0));
        if (delta > 0) {
          result.addedQty += Math.abs(delta);
          result.addedValue += valor;
        } else {
          result.removedQty += Math.abs(delta);
          result.removedValue += valor;
        }
      } catch (err) {
        result.errors.push({
          productId: row.productId,
          name: nombre,
          message: err instanceof Error ? err.message : 'Error desconocido',
        });
      }
    }

    return result;
  }

  /**
   * Carga masiva de existencias desde filas de CSV: cada fila es una ENTRADA
   * (suma stock) de un producto (por SKU) en una sede (por nombre o código).
   * Reutiliza `entry`, así que respeta lotes, costo, vencimiento de perecederos
   * y el control de acceso por sede del usuario. Procesa fila por fila: un error
   * en una no aborta el resto (se acumula con su número de fila).
   */
  async importStock(
    rows: ImportStockRow[],
    user: JwtUser,
  ): Promise<ImportStockResult> {
    const result: ImportStockResult = {
      total: rows.length,
      imported: 0,
      errors: [],
    };

    // Índice de sedes por nombre y por código (normalizados) → id.
    const norm = (s: string): string =>
      s
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
    const sedes = await this.sedes.list();
    const sedeByKey = new Map<string, string>();
    for (const s of sedes) {
      sedeByKey.set(norm(s.name), s._id.toString());
      if (s.code) sedeByKey.set(norm(s.code), s._id.toString());
    }

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row) continue;
      const line = i + 2; // fila 1 = encabezado del CSV
      const sku = row.sku?.trim().toUpperCase() ?? '';
      const sedeLabel = row.sede?.trim() ?? '';
      try {
        if (!sku) throw new Error('Falta el SKU');
        const product = await this.products.findBySku(sku);
        if (!product) throw new Error(`No existe un producto con SKU ${sku}`);

        if (!sedeLabel) throw new Error('Falta la sede');
        const sedeId = sedeByKey.get(norm(sedeLabel));
        if (!sedeId) throw new Error(`No existe la sede "${sedeLabel}"`);

        const qty = row.qty;
        if (qty === undefined || !(qty > 0)) {
          throw new Error('La cantidad debe ser mayor a 0');
        }

        await this.entry(
          {
            productId: product._id.toString(),
            sedeId,
            qty,
            unitCost: row.unitCost,
            lotCode: row.lotCode?.trim() || undefined,
            supplier: row.supplier?.trim() || undefined,
            expiresAt: row.expiresAt?.trim() || undefined,
            note: row.note?.trim() || 'Carga CSV de existencias',
          } as StockEntryDto,
          user,
        );
        result.imported += 1;
      } catch (err) {
        result.errors.push({
          row: line,
          sku,
          sede: sedeLabel,
          message: err instanceof Error ? err.message : 'Error desconocido',
        });
      }
    }

    return result;
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
    return this.consumeLines('sale', sedeId, lines, user);
  }

  // ─── Consumo genérico ──────────────────────────────────────────────────────

  /**
   * Descuenta varias líneas del stock de una sede en una sola transacción,
   * consumiendo lotes FEFO y registrando movimientos del tipo indicado. Falla
   * completa si alguna línea no tiene stock suficiente.
   *
   * Es el primitivo que comparten la venta ('sale') y la producción
   * ('production_out'): quien transforma mercancía necesita exactamente el
   * mismo descuento por lotes que quien la vende, y devolver las porciones
   * consumidas es lo que permite costear el lote resultante con el costo REAL
   * de lo que entró, no con un promedio.
   */
  async consumeLines(
    type: MovementType,
    sedeId: string,
    lines: ConsumeLineInput[],
    user: JwtUser,
    meta: { note?: string; reason?: string } = {},
  ): Promise<ConsumedLine[]> {
    await this.sedes.findOrFail(sedeId);
    const sede = new Types.ObjectId(sedeId);
    const items = await Promise.all(
      lines.map(async (l) => ({
        product: await this.products.getOrFail(l.productId),
        qty: l.qty,
      })),
    );

    return this.withTransaction(async (session) => {
      const consumed: ConsumedLine[] = [];
      for (const { product, qty } of items) {
        const { item, portions } = await this.consume(
          product,
          sede,
          qty,
          session,
        );
        await this.recordExits(type, product, sede, item, portions, session, {
          user,
          note: meta.note,
          reason: meta.reason,
        });
        consumed.push({ product, portions });
      }
      return consumed;
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

  /**
   * Existencia de un producto en una sede (0 si nunca ha tenido).
   *
   * Sirve para comprobar disponibilidad ANTES de empezar una operación de
   * varias líneas: `consume` también protege, pero lo hace a mitad de camino y
   * en un Mongo sin réplicas eso deja la operación a medias. Es una lectura
   * orientativa —entre la consulta y el descuento cabe otra venta—, así que no
   * sustituye al decremento condicional, solo evita el caso común.
   */
  async availableQty(productId: string, sedeId: string): Promise<number> {
    const item = await this.stockItemModel
      .findOne({
        productId: new Types.ObjectId(productId),
        sedeId: new Types.ObjectId(sedeId),
      })
      .exec();
    return item?.qty ?? 0;
  }

  /**
   * Existencias de varios productos de una vez, como mapa `productId -> qty`.
   *
   * Una sola agregación en vez de N lecturas: quien pinta un tablero de
   * terminados necesita el stock de todos a la vez, y hacerlo producto a
   * producto convierte una pantalla en una tormenta de consultas.
   */
  async qtyByProduct(
    productIds: (Types.ObjectId | string)[],
    sedeId?: string,
    restrict?: string[] | null,
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const match: Record<string, unknown> = {
      productId: { $in: productIds.map((id) => new Types.ObjectId(id)) },
      ...(this.sedeMatch(sedeId, restrict) ?? {}),
    };
    const rows = await this.stockItemModel.aggregate<{
      _id: Types.ObjectId;
      qty: number;
    }>([
      { $match: match },
      { $group: { _id: '$productId', qty: { $sum: '$qty' } } },
    ]);
    return new Map(rows.map((r) => [r._id.toString(), r.qty]));
  }

  /** Existencias consolidadas (opcionalmente filtradas por sede). */
  async stock(sedeId?: string, restrict?: string[] | null) {
    const sedeMatch = this.sedeMatch(sedeId, restrict);
    const filter = sedeMatch ?? {};
    const items = await this.stockItemModel
      .find(filter)
      // Anidado: la UI muestra la categoría del producto en existencias.
      .populate({
        path: 'productId',
        model: this.productModel,
        populate: {
          path: 'categoryId',
          select: 'name',
          model: this.categoryModel,
        },
      })
      .populate({ path: 'sedeId', select: 'code name', model: this.sedeModel })
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
      .populate({ path: 'sedeId', select: 'code name', model: this.sedeModel })
      .exec();
    return this.sortFefo(lots);
  }

  /**
   * Todos los lotes abiertos, para la pestaña "Lotes" del inventario.
   *
   * `lots()` responde a "qué lotes tiene ESTE producto en ESTA sede", que es
   * lo que hace falta al desplegar una fila de existencias. Esta responde a la
   * otra pregunta, la que se hace de mañana al abrir: "¿qué tengo por vencer o
   * ya vencido, en cualquier producto?". Sin ella había que ir producto por
   * producto desplegando filas.
   *
   * `status` filtra por vencimiento: `expired` lo ya vencido, `expiring` lo que
   * vence dentro de `days` días, `ok` el resto (incluido lo que no caduca).
   * El orden es siempre FEFO: lo que primero vence, primero se ve.
   */
  async allLots(query: {
    sedeId?: string;
    productId?: string;
    status?: 'all' | 'expired' | 'expiring' | 'ok';
    days?: number;
    restrict?: string[] | null;
  }) {
    const days = query.days && query.days > 0 ? query.days : 30;
    const now = new Date();
    const limitDate = new Date();
    limitDate.setDate(limitDate.getDate() + days);

    const filter: Record<string, unknown> = {
      qty: { $gt: 0 },
      ...this.sedeMatch(query.sedeId, query.restrict),
    };
    if (query.productId && Types.ObjectId.isValid(query.productId)) {
      filter.productId = new Types.ObjectId(query.productId);
    }
    if (query.status === 'expired') {
      filter.expiresAt = { $lt: now };
    } else if (query.status === 'expiring') {
      filter.expiresAt = { $gte: now, $lte: limitDate };
    } else if (query.status === 'ok') {
      filter.$or = [{ expiresAt: { $gt: limitDate } }, { expiresAt: null }];
    }

    const lots = await this.lotModel
      .find(filter)
      .populate({
        path: 'productId',
        select: 'sku name unit trackLots perishable imageUrl',
        model: this.productModel,
      })
      .populate({ path: 'sedeId', select: 'code name', model: this.sedeModel })
      .limit(500)
      .exec();

    return { days, rows: this.sortFefo(lots) };
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
        .populate({
          path: 'productId',
          select: 'sku name unit',
          model: this.productModel,
        })
        .populate({ path: 'sedeId', select: 'code name', model: this.sedeModel })
        .populate({
          path: 'lotId',
          select: 'lotCode expiresAt',
          model: this.lotModel,
        })
        .exec(),
    ]);

    return { total, page, limit, rows };
  }

  /**
   * Reporte de merma: qué se botó, por qué y cuánto costó.
   *
   * La merma es la plata que se pierde sin que nadie la vea salir. Cada baja
   * queda en el kárdex desde siempre, pero una a una no dice nada: lo que
   * revela el problema es el acumulado —"el mes pasado se botaron $340.000 de
   * leche por vencimiento"— y eso hasta ahora tocaba armarlo a mano.
   *
   * Se cuentan los movimientos de tipo `waste`, que son los que el inventario
   * registra cuando la razón es daño, vencimiento o merma de proceso. Un ajuste
   * por conteo NO es merma: es una corrección de lo que el sistema creía, y
   * mezclarlo escondería el problema de verdad detrás del ruido del inventario.
   *
   * El costo sale del `unitCost` que el movimiento guardó, que es el del lote
   * que salió. No se recalcula con el costo de hoy: lo que se perdió se perdió
   * al precio al que se había comprado.
   */
  async wasteReport(query: {
    sedeId?: string;
    from?: string;
    to?: string;
    restrict?: string[] | null;
  }) {
    const filter: Record<string, unknown> = {
      type: 'waste',
      ...this.sedeMatch(query.sedeId, query.restrict),
    };
    const rango: Record<string, Date> = {};
    if (query.from) rango.$gte = new Date(`${query.from}T00:00:00`);
    // El `to` es inclusivo: quien escribe "hasta el 30" espera que el 30 entre.
    if (query.to) rango.$lte = new Date(`${query.to}T23:59:59.999`);
    if (Object.keys(rango).length > 0) filter.createdAt = rango;

    const movimientos = await this.movementModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(5000)
      .populate({
        path: 'productId',
        select: 'sku name unit',
        model: this.productModel,
      })
      .populate({ path: 'sedeId', select: 'code name', model: this.sedeModel })
      .exec();

    type Fila = {
      productId: string;
      sku: string;
      name: string;
      unit: string;
      qty: number;
      value: number;
      /** Cuánto se fue por cada razón, para saber dónde atacar. */
      byReason: Record<string, { qty: number; value: number }>;
    };

    const porProducto = new Map<string, Fila>();
    const porRazon: Record<string, { qty: number; value: number }> = {};
    let totalQty = 0;
    let totalValue = 0;

    for (const m of movimientos) {
      const product = m.productId as unknown as {
        _id: Types.ObjectId;
        sku?: string;
        name?: string;
        unit?: string;
      } | null;
      if (!product?._id) continue; // producto borrado: no se puede reportar

      // El `delta` de una salida es negativo; la merma se lee en positivo.
      const qty = Math.abs(m.delta);
      const value = cop(qty * (m.unitCost ?? 0));
      const razon = m.reason ?? 'otro';
      const key = product._id.toString();

      const fila = porProducto.get(key) ?? {
        productId: key,
        sku: product.sku ?? '',
        name: product.name ?? 'Producto eliminado',
        unit: product.unit ?? 'und',
        qty: 0,
        value: 0,
        byReason: {},
      };
      fila.qty += qty;
      fila.value += value;
      fila.byReason[razon] = {
        qty: (fila.byReason[razon]?.qty ?? 0) + qty,
        value: (fila.byReason[razon]?.value ?? 0) + value,
      };
      porProducto.set(key, fila);

      porRazon[razon] = {
        qty: (porRazon[razon]?.qty ?? 0) + qty,
        value: (porRazon[razon]?.value ?? 0) + value,
      };
      totalQty += qty;
      totalValue += value;
    }

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      totalQty,
      totalValue,
      byReason: porRazon,
      // De mayor a menor plata perdida: lo primero que hay que mirar es lo que
      // más cuesta, no lo que más veces pasó.
      rows: [...porProducto.values()].sort((a, b) => b.value - a.value),
      movements: movimientos.length,
    };
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
          .populate({
            path: 'productId',
            select: 'sku name unit perishable',
            model: this.productModel,
          })
          .populate({
            path: 'sedeId',
            select: 'code name',
            model: this.sedeModel,
          })
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
