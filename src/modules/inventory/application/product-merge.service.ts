import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { TenantModelRegistry } from '../../../shared/tenancy/tenant-model.registry';
import {
  Product,
  ProductDocument,
} from '../infrastructure/schemas/product.schema';
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
import { ProductsService } from './products.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { MovementType } from '../domain/inventory.constants';
import { mergeProblem } from '../domain/product-merge';

export interface MergeProductsResult {
  targetId: string;
  mergedIds: string[];
  /** Cantidad trasladada, sumando todas las sedes (en la unidad del producto). */
  stockMoved: number;
  lots: number;
  /** Vendibles del POS que se abastecían del producto fusionado. */
  catalog: number;
  /** Renglones de receta, empaque o receta de lote que ahora usan el que se queda. */
  recipes: number;
  purchaseOrders: number;
  productionOrders: number;
  aliases: number;
  scans: number;
}

/** Estados en que un documento todavía va a mover inventario. */
const OPEN_PURCHASE_ORDERS = ['draft', 'sent', 'partial'];
const OPEN_PRODUCTION_ORDERS = ['draft', 'in_progress'];

/**
 * Fusiona productos duplicados en uno.
 *
 * Todo lo que todavía va a MOVER inventario pasa al producto que se queda: sus
 * existencias, lotes, recetas del POS y de producción, compras y órdenes de
 * producción abiertas, facturas escaneadas sin aplicar y los alias con que lo
 * reconocen los proveedores. Lo que ya PASÓ no se reescribe: ventas,
 * devoluciones, compras recibidas, órdenes terminadas y el kardex conservan el
 * producto con que ocurrieron, que es lo que dice el papel.
 *
 * El fusionado no se borra: queda inactivo y apuntando al que se queda
 * (`mergedInto`), para que su historial siga teniendo a quién referirse.
 *
 * Las colecciones de otros módulos se tocan con la conexión de la empresa y no
 * con sus modelos: inyectarlos aquí obligaría al inventario a importar compras,
 * producción, catálogo y facturas, que ya lo importan a él.
 */
@Injectable()
export class ProductMergeService {
  private readonly logger = new Logger(ProductMergeService.name);

  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockItem.name)
    private readonly stockItemModel: Model<StockItemDocument>,
    @InjectModel(StockLot.name)
    private readonly lotModel: Model<StockLotDocument>,
    @InjectModel(StockMovement.name)
    private readonly movementModel: Model<StockMovementDocument>,
    private readonly tenant: TenantModelRegistry,
    private readonly products: ProductsService,
  ) {}

  async merge(
    targetId: string,
    sourceIds: string[],
    user: JwtUser,
  ): Promise<MergeProductsResult> {
    const ids = [...new Set(sourceIds.map(String))].filter((id) => id !== targetId);
    if (ids.length === 0) {
      throw new BadRequestException(
        'Elige al menos otro producto para fusionar con este.',
      );
    }

    // Todo se valida ANTES de tocar nada: una fusión a medias es peor que
    // ninguna.
    const target = await this.products.getOrFail(targetId);
    const sources = await Promise.all(ids.map((id) => this.products.getOrFail(id)));
    for (const source of sources) {
      const problem = mergeProblem(target, source);
      if (problem) throw new BadRequestException(problem);
    }

    const result: MergeProductsResult = {
      targetId,
      mergedIds: ids,
      stockMoved: 0,
      lots: 0,
      catalog: 0,
      recipes: 0,
      purchaseOrders: 0,
      productionOrders: 0,
      aliases: 0,
      scans: 0,
    };

    const connection = this.tenant.connectionFor();
    await this.withTransaction(connection, async (session) => {
      for (const source of sources) {
        await this.absorb(connection, target, source, user, result, session);
      }
    });

    // El vendible automático del POS se rehace fuera de la transacción, como
    // en el resto del inventario: el catálogo no participa del arrastre.
    for (const source of sources) {
      await this.products.syncCatalogRemoved(source._id as Types.ObjectId);
    }
    await this.products.syncCatalogFor(await this.products.getOrFail(targetId));

    this.logger.log(
      `Fusión en ${target.sku}: ${sources.map((s) => s.sku).join(', ')} · ${result.stockMoved} ${target.unit} trasladadas`,
    );
    return result;
  }

  /** Pasa todo lo vivo de `source` a `target` y deja `source` inactivo. */
  private async absorb(
    connection: Connection,
    target: ProductDocument,
    source: ProductDocument,
    user: JwtUser,
    result: MergeProductsResult,
    session?: ClientSession,
  ): Promise<void> {
    const src = source._id as Types.ObjectId;
    const dst = target._id as Types.ObjectId;
    const note = `Fusión: ${source.name} (${source.sku}) → ${target.name} (${target.sku})`;

    // 1. Existencias, sede por sede. Se registran como movimientos y no como
    //    un cambio silencioso: en el kardex de cada producto tiene que verse
    //    por qué su saldo cambió.
    const items = await this.stockItemModel
      .find({ productId: src })
      .session(session ?? null)
      .exec();
    for (const item of items) {
      const qty = item.qty;
      if (!qty) continue;

      const merged = await this.stockItemModel
        .findOneAndUpdate(
          { productId: dst, sedeId: item.sedeId },
          { $inc: { qty } },
          { upsert: true, new: true, session },
        )
        .exec();
      await this.stockItemModel
        .updateOne({ _id: item._id }, { $set: { qty: 0 } }, { session })
        .exec();

      // Si el que se queda controla lotes y el fusionado no, sus existencias
      // entrarían sin lote y el consumo FEFO no las encontraría.
      if (target.trackLots && !source.trackLots && qty > 0) {
        await this.lotModel.create(
          [
            {
              productId: dst,
              sedeId: item.sedeId,
              lotCode: `FUSION-${source.sku}`,
              qty,
              initialQty: qty,
              unitCost: source.cost ?? 0,
              receivedAt: new Date(),
            },
          ],
          { session },
        );
      }

      await this.movementModel.create(
        [
          {
            type: 'merge_out' satisfies MovementType,
            productId: src,
            sedeId: item.sedeId,
            delta: -qty,
            balanceAfter: 0,
            unitCost: source.cost ?? 0,
            note,
            userId: user.userId,
            userEmail: user.email,
          },
          {
            type: 'merge_in' satisfies MovementType,
            productId: dst,
            sedeId: item.sedeId,
            delta: qty,
            balanceAfter: merged?.qty ?? qty,
            unitCost: source.cost ?? 0,
            note,
            userId: user.userId,
            userEmail: user.email,
          },
        ],
        { session, ordered: true },
      );
      result.stockMoved += qty;
    }

    // 2. Lotes.
    const lots = await this.lotModel
      .updateMany({ productId: src }, { $set: { productId: dst } }, { session })
      .exec();
    result.lots += lots.modifiedCount;

    const collection = (name: string) => connection.collection(name);
    /** Cambia el producto dentro de un arreglo de renglones (receta, líneas…). */
    const repoint = async (
      name: string,
      filter: Record<string, unknown>,
      path: string,
    ): Promise<number> => {
      const updated = await collection(name).updateMany(
        { ...filter, [`${path}.productId`]: src },
        { $set: { [`${path}.$[line].productId`]: dst } },
        { arrayFilters: [{ 'line.productId': src }], session },
      );
      return updated.modifiedCount;
    };

    // 3. Catálogo del POS: vendibles hechos a mano que se abastecían del
    //    fusionado, y recetas y empaques que lo consumen. Sus vendibles
    //    automáticos se retiran al final (`syncCatalogRemoved`).
    const catalog = await collection('catalog_products').updateMany(
      { inventoryProductId: src, autoFromInventory: { $ne: true } },
      { $set: { inventoryProductId: dst } },
      { session },
    );
    result.catalog += catalog.modifiedCount;
    result.recipes += await repoint('catalog_products', {}, 'recipe');
    result.recipes += await repoint('catalog_products', {}, 'packaging');

    // 4. Recetas de lote: como insumo, y su propia receta si la tenía. Un
    //    terminado solo puede tener una receta vigente; si el que se queda ya
    //    tiene la suya, la del fusionado se desactiva en vez de pisarla.
    result.recipes += await repoint('bom_recipes', {}, 'lines');
    const ownBom = await collection('bom_recipes').findOne({ productId: src }, { session });
    if (ownBom) {
      const targetBom = await collection('bom_recipes').findOne(
        { productId: dst },
        { session },
      );
      await collection('bom_recipes').updateOne(
        { _id: ownBom._id },
        targetBom ? { $set: { active: false } } : { $set: { productId: dst } },
        { session },
      );
      result.recipes += 1;
    }

    // 5. Documentos que todavía van a mover inventario.
    result.purchaseOrders += await repoint(
      'purchase_orders',
      { status: { $in: OPEN_PURCHASE_ORDERS } },
      'lines',
    );
    const productionOutputs = await collection('production_orders').updateMany(
      { status: { $in: OPEN_PRODUCTION_ORDERS }, productId: src },
      { $set: { productId: dst } },
      { session },
    );
    result.productionOrders += productionOutputs.modifiedCount;
    result.productionOrders += await repoint(
      'production_orders',
      { status: { $in: OPEN_PRODUCTION_ORDERS } },
      'lines',
    );
    result.scans += await repoint(
      'invoice_scans',
      { status: { $nin: ['applied', 'discarded'] } },
      'lineDecisions',
    );

    // 6. Cómo lo llaman los proveedores: la próxima factura se empareja sola
    //    con el que se queda.
    const aliases = await collection('supplier_item_aliases').updateMany(
      { productId: src },
      { $set: { productId: dst } },
      { session },
    );
    result.aliases += aliases.modifiedCount;

    // 7. Fichas. El que se queda hereda lo que no tenía; no pisa lo que ya
    //    tenía, que es lo que la persona eligió conservar.
    await this.productModel
      .updateOne(
        { _id: src },
        { $set: { active: false, mergedInto: dst, mergedAt: new Date() } },
        { session },
      )
      .exec();
    const inherited: Partial<Pick<Product, 'barcode' | 'cost' | 'salePrice'>> = {};
    if (!target.barcode && source.barcode) inherited.barcode = source.barcode;
    if (!target.cost && source.cost) inherited.cost = source.cost;
    if (!target.salePrice && source.salePrice) inherited.salePrice = source.salePrice;
    if (Object.keys(inherited).length > 0) {
      await this.productModel
        .updateOne({ _id: dst }, { $set: inherited }, { session })
        .exec();
      // Para que un segundo fusionado no vuelva a heredar lo mismo.
      Object.assign(target, inherited);
    }
  }

  /**
   * Transacción sobre la base de la empresa. Sin replica set (desarrollo) se
   * sigue sin sesión, igual que en `StockService`.
   */
  private async withTransaction(
    connection: Connection,
    fn: (session?: ClientSession) => Promise<void>,
  ): Promise<void> {
    try {
      await connection.transaction((session) => fn(session));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/replica set|transaction numbers|retryable writes/i.test(message)) {
        this.logger.warn('MongoDB sin soporte de transacciones; fusión sin sesión');
        await fn(undefined);
        return;
      }
      throw err;
    }
  }
}
