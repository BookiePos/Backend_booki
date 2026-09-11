import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  BillOfMaterials,
  BillOfMaterialsDocument,
} from '../infrastructure/schemas/bill-of-materials.schema';
import {
  ProductionOrder,
  ProductionOrderDocument,
} from '../infrastructure/schemas/production-order.schema';
import {
  Counter,
  CounterDocument,
} from '../../sales/infrastructure/schemas/counter.schema';
import { ProductsService } from '../../inventory/application/products.service';
import { CatalogService } from '../../catalog/application/catalog.service';
import {
  ConsumedLine,
  StockService,
} from '../../inventory/application/stock.service';
import {
  Product,
  ProductDocument,
} from '../../inventory/infrastructure/schemas/product.schema';
import { cop, sumBy, sumCop } from '../../finance/domain/money.util';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';
import {
  OPEN_PRODUCTION_STATUSES,
  PRODUCTION_COUNTER_KEY,
  PRODUCTION_LOT_PREFIX,
  PRODUCTION_ORDER_PREFIX,
  ProductionOrderStatus,
} from '../domain/production.constants';
import {
  CompleteProductionOrderDto,
  CreateBomDto,
  CreateProductionOrderDto,
  ProductionLineDto,
  PublishOutputDto,
  UpdateBomDto,
  UpdateProductionOrderDto,
} from './dto/production.dto';

/** Renglón de insumo tal como se persiste en la orden. */
interface BuiltLine {
  productId: Types.ObjectId;
  description: string;
  unit: string;
  qty: number;
  qtyConsumed: number;
  unitCost: number;
  subtotal: number;
}

/**
 * Cantidades de insumo redondeadas a 4 decimales.
 *
 * Explotar una receta multiplica por una fracción (`plannedQty / outputQty`) y
 * eso saca periódicos: 0.008333333333333333 kg de sal no significa nada y
 * arrastra basura al kardex. Cuatro decimales cubren de sobra el gramo dentro
 * de un kilo, que es la unidad más fina que maneja el inventario.
 */
function qtyRound(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Id de una referencia que `populate` pudo haber convertido en documento.
 * Las mismas consultas se usan pobladas y sin poblar, y un `toString()` sobre
 * el documento devuelve su JSON, no su id.
 */
function refId(ref: unknown): string {
  if (ref && typeof ref === 'object' && '_id' in ref) {
    return String((ref as { _id: unknown })._id);
  }
  return String(ref);
}

/** Resumen de la última orden terminada de un producto. */
export interface LastProductionOrder {
  _id: string;
  number: string;
  date: string;
  completedAt?: string;
  producedQty: number;
  unitCost: number;
  totalCost: number;
}

/** Fila del tablero de terminados: insumos → receta → terminado → vendible. */
export interface ProductionOutput {
  bomId: string;
  name: string;
  outputQty: number;
  extraCost: number;
  lines: {
    productId: string;
    sku: string;
    name: string;
    unit: string;
    qty: number;
    unitCost: number;
    subtotal: number;
  }[];
  product: {
    _id: string;
    sku: string;
    name: string;
    unit: string;
    itemType: string;
    perishable: boolean;
    active: boolean;
  };
  /** Existencia del terminado (en la sede filtrada, o en todas las visibles). */
  stock: number;
  /** Costo por unidad según los costos actuales del catálogo de inventario. */
  estimatedUnitCost: number;
  /** Costo de referencia: el de la última orden, o el estimado si nunca se produjo. */
  unitCost: number;
  lastOrder?: LastProductionOrder;
  sellable?: {
    _id: string;
    sku: string;
    name: string;
    salePrice: number;
    ivaRate: number;
    ivaType: string;
    active: boolean;
  };
  margin?: number;
  marginPct?: number;
}

@Injectable()
export class ProductionService {
  private readonly logger = new Logger(ProductionService.name);

  constructor(
    @InjectModel(BillOfMaterials.name)
    private readonly boms: Model<BillOfMaterialsDocument>,
    @InjectModel(ProductionOrder.name)
    private readonly orders: Model<ProductionOrderDocument>,
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
    private readonly products: ProductsService,
    private readonly stock: StockService,
    private readonly catalog: CatalogService,
    /**
     * Modelo referenciado por `populate`. Va EXPLÍCITO en cada populate porque
     * los modelos se compilan de forma perezosa sobre la base de cada empresa:
     * si el referenciado todavía no lo estaba, mongoose lanzaba
     * MissingSchemaError y la pantalla salía en 500 hasta que otra petición lo
     * compilara. Se declara al final para no mover el orden de los parámetros
     * ya existentes (varias pruebas construyen el servicio posicionalmente).
     */
    @InjectModel(Product.name)
    private readonly productModel: Model<unknown>,
  ) {}

  // ─── Recetas de lote (BOM) ─────────────────────────────────────────────────

  listBoms(includeInactive = false): Promise<BillOfMaterialsDocument[]> {
    const filter = includeInactive ? {} : { active: true };
    return this.boms
      .find(filter)
      .populate({
        path: 'productId',
        select: 'sku name unit itemType perishable cost active',
        model: this.productModel,
      })
      .populate({
        path: 'lines.productId',
        select: 'sku name unit cost active',
        model: this.productModel,
      })
      .sort({ name: 1 })
      .exec();
  }

  async getBom(id: string): Promise<BillOfMaterialsDocument> {
    const bom = await this.boms
      .findById(id)
      .populate({
        path: 'productId',
        select: 'sku name unit itemType perishable cost active',
        model: this.productModel,
      })
      .populate({
        path: 'lines.productId',
        select: 'sku name unit cost active',
        model: this.productModel,
      })
      .exec();
    if (!bom) throw new NotFoundException('Receta no encontrada');
    return bom;
  }

  /** Receta vigente de un terminado, o null si no tiene. */
  bomForProduct(productId: string): Promise<BillOfMaterialsDocument | null> {
    return this.boms
      .findOne({ productId: new Types.ObjectId(productId), active: true })
      .exec();
  }

  async createBom(dto: CreateBomDto): Promise<BillOfMaterialsDocument> {
    const output = await this.products.getOrFail(dto.productId);
    if (!output.active) {
      throw new BadRequestException('El terminado está inactivo');
    }
    const lines = await this.validateBomLines(dto.lines, output);

    const exists = await this.boms.exists({ productId: output._id }).exec();
    if (exists) {
      throw new ConflictException(
        `${output.name} ya tiene una receta; edítala en vez de crear otra`,
      );
    }

    const created = await this.boms.create({
      productId: output._id,
      name: dto.name.trim(),
      outputQty: dto.outputQty,
      lines,
      extraCost: cop(dto.extraCost ?? 0),
      note: dto.note,
      active: true,
    });
    return this.getBom(created._id.toString());
  }

  async updateBom(
    id: string,
    dto: UpdateBomDto,
  ): Promise<BillOfMaterialsDocument> {
    const bom = await this.boms.findById(id).exec();
    if (!bom) throw new NotFoundException('Receta no encontrada');

    if (dto.name !== undefined) bom.name = dto.name.trim();
    if (dto.outputQty !== undefined) bom.outputQty = dto.outputQty;
    if (dto.extraCost !== undefined) bom.extraCost = cop(dto.extraCost);
    if (dto.note !== undefined) bom.note = dto.note;
    if (dto.active !== undefined) bom.active = dto.active;
    if (dto.lines) {
      const output = await this.products.getOrFail(bom.productId.toString());
      bom.lines = (await this.validateBomLines(
        dto.lines,
        output,
      )) as unknown as typeof bom.lines;
    }
    await bom.save();
    return this.getBom(bom._id.toString());
  }

  async removeBom(id: string): Promise<void> {
    const bom = await this.boms.findById(id).exec();
    if (!bom) throw new NotFoundException('Receta no encontrada');
    await bom.deleteOne();
  }

  /**
   * Valida los insumos de una receta: existen, están activos, no se repiten y
   * ninguno es el propio terminado. Lo último no es paranoia: una receta que se
   * consume a sí misma vacía el stock del terminado cada vez que se fabrica.
   */
  private async validateBomLines(
    lines: { productId: string; qty: number; note?: string }[],
    output: ProductDocument,
  ): Promise<{ productId: Types.ObjectId; qty: number; note?: string }[]> {
    const seen = new Set<string>();
    const result: { productId: Types.ObjectId; qty: number; note?: string }[] =
      [];
    for (const line of lines) {
      if (line.productId === output._id.toString()) {
        throw new BadRequestException(
          `${output.name} no puede ser insumo de su propia receta`,
        );
      }
      if (seen.has(line.productId)) {
        throw new BadRequestException(
          'Hay un insumo repetido; súmalo en un solo renglón',
        );
      }
      seen.add(line.productId);
      const input = await this.products.getOrFail(line.productId);
      if (!input.active) {
        throw new BadRequestException(`El insumo ${input.name} está inactivo`);
      }
      result.push({
        productId: input._id,
        qty: qtyRound(line.qty),
        note: line.note,
      });
    }
    return result;
  }

  // ─── Órdenes de producción ─────────────────────────────────────────────────

  /**
   * Consecutivo de OP vía $inc atómico (no requiere transacciones), sobre la
   * misma colección de contadores que usan ventas y compras.
   */
  private async nextNumber(): Promise<string> {
    const counter = await this.counterModel
      .findOneAndUpdate(
        { _id: PRODUCTION_COUNTER_KEY },
        { $inc: { seq: 1 } },
        { upsert: true, new: true },
      )
      .exec();
    return `${PRODUCTION_ORDER_PREFIX}-${String(counter.seq).padStart(6, '0')}`;
  }

  list(
    user: JwtUser,
    query: { sedeId?: string; status?: ProductionOrderStatus },
  ): Promise<ProductionOrderDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.sedeId) {
      assertSedeAccess(user, query.sedeId);
      filter.sedeId = new Types.ObjectId(query.sedeId);
    } else {
      const allowed = allowedSedeIds(user);
      if (allowed) {
        filter.sedeId = { $in: allowed.map((id) => new Types.ObjectId(id)) };
      }
    }
    if (query.status) filter.status = query.status;
    return this.orders.find(filter).sort({ createdAt: -1 }).exec();
  }

  async get(id: string, user: JwtUser): Promise<ProductionOrderDocument> {
    const order = await this.orders.findById(id).exec();
    if (!order) {
      throw new NotFoundException('Orden de producción no encontrada');
    }
    assertSedeAccess(user, order.sedeId.toString());
    return order;
  }

  async create(
    dto: CreateProductionOrderDto,
    user: JwtUser,
  ): Promise<ProductionOrderDocument> {
    assertSedeAccess(user, dto.sedeId);
    const output = await this.products.getOrFail(dto.productId);
    if (!output.active) {
      throw new BadRequestException('El terminado está inactivo');
    }

    const { lines, extraCost, bomId } = await this.resolveLines(
      output,
      dto.plannedQty,
      dto.lines,
      dto.extraCost,
    );

    return this.orders.create({
      number: await this.nextNumber(),
      sedeId: new Types.ObjectId(dto.sedeId),
      status: dto.start ? 'in_progress' : 'draft',
      date: dto.date,
      bomId,
      productId: output._id,
      productName: output.name,
      unit: output.unit,
      plannedQty: qtyRound(dto.plannedQty),
      producedQty: 0,
      lines,
      extraCost,
      materialsCost: 0,
      totalCost: 0,
      unitCost: 0,
      note: dto.note,
      createdByEmail: user.email,
    });
  }

  async update(
    id: string,
    dto: UpdateProductionOrderDto,
    user: JwtUser,
  ): Promise<ProductionOrderDocument> {
    const order = await this.get(id, user);
    if (order.status !== 'draft') {
      throw new BadRequestException(
        'Solo se puede editar una orden en borrador',
      );
    }
    if (dto.date !== undefined) order.date = dto.date;
    if (dto.note !== undefined) order.note = dto.note;

    // Cambiar la cantidad reexplota la receta: producir el doble con los mismos
    // insumos no es una orden válida, y dejar que se guarde así es fabricar un
    // costo unitario falso que después nadie sabe de dónde salió.
    const nextQty = dto.plannedQty ?? order.plannedQty;
    if (dto.plannedQty !== undefined || dto.lines || dto.extraCost !== undefined) {
      const output = await this.products.getOrFail(order.productId.toString());
      const { lines, extraCost, bomId } = await this.resolveLines(
        output,
        nextQty,
        dto.lines,
        // Con insumos explícitos no hay receta de la que prorratear la mano de
        // obra, así que se conserva la que ya tenía la orden en vez de dejarla
        // en cero por omisión y falsear el costo del lote.
        dto.extraCost ?? (dto.lines ? order.extraCost : undefined),
      );
      order.lines = lines as unknown as typeof order.lines;
      order.extraCost = extraCost;
      order.bomId = bomId;
    }
    order.plannedQty = qtyRound(nextQty);
    await order.save();
    return order;
  }

  async start(id: string, user: JwtUser): Promise<ProductionOrderDocument> {
    const order = await this.get(id, user);
    if (order.status !== 'draft') {
      throw new BadRequestException('La orden ya fue iniciada o cerrada');
    }
    order.status = 'in_progress';
    await order.save();
    return order;
  }

  async cancel(id: string, user: JwtUser): Promise<ProductionOrderDocument> {
    const order = await this.get(id, user);
    if (order.status === 'done') {
      throw new BadRequestException(
        'No se anula una orden terminada; corrige con un ajuste de inventario',
      );
    }
    if (order.status === 'cancelled') return order;
    order.status = 'cancelled';
    await order.save();
    return order;
  }

  /**
   * Cierra la orden: descuenta los insumos, ingresa el terminado con su lote y
   * deja costeado el batch.
   *
   * Idempotencia y fallos parciales (Mongo standalone, sin transacción que
   * abarque los dos servicios). El orden de los pasos es deliberado:
   *
   *  1. Se comprueba la disponibilidad de TODOS los insumos antes de tocar
   *     nada. Es el fallo común —falta harina— y así se rechaza limpio, con la
   *     orden intacta y un mensaje que dice qué falta y cuánto.
   *  2. El cierre se RESERVA de forma atómica y condicionada al estado abierto
   *     (`findOneAndUpdate`). Si otra llamada ya cerró la orden, esta no
   *     encuentra el documento y devuelve el estado actual sin volver a
   *     consumir: es lo que evita el doble descuento en un reintento o en dos
   *     clics simultáneos de "Terminar".
   *  3. Recién entonces se mueve el stock.
   *
   * La ventana que queda es un crash ENTRE la reserva y los movimientos: la
   * orden figura terminada sin haber movido inventario. Se registra en el log y
   * se corrige con un ajuste manual. Es preferible al doble consumo silencioso
   * que produciría el orden inverso, que además nadie detecta.
   */
  async complete(
    id: string,
    dto: CompleteProductionOrderDto,
    user: JwtUser,
  ): Promise<ProductionOrderDocument> {
    const order = await this.get(id, user);
    if (!OPEN_PRODUCTION_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        order.status === 'done'
          ? 'La orden ya está terminada'
          : 'No se puede terminar una orden anulada',
      );
    }
    if (order.lines.length === 0) {
      throw new BadRequestException('La orden no tiene insumos que consumir');
    }

    const output = await this.products.getOrFail(order.productId.toString());
    const producedQty = qtyRound(dto.producedQty ?? order.plannedQty);
    if (!(producedQty > 0)) {
      throw new BadRequestException('La cantidad producida debe ser mayor a 0');
    }
    if (output.perishable && !dto.expiresAt) {
      throw new BadRequestException(
        `${output.name} es perecedero: indica la fecha de vencimiento del lote producido`,
      );
    }
    const sedeId = order.sedeId.toString();
    const extraCost = cop(dto.extraCost ?? order.extraCost);

    // 1. Disponibilidad de todos los insumos (ver el docblock).
    await this.assertMaterialsAvailable(order, sedeId);

    // 2. Reserva atómica del cierre.
    const lotCode =
      dto.lotCode?.trim() || `${PRODUCTION_LOT_PREFIX}-${order.number}`;
    const reserved = await this.orders
      .findOneAndUpdate(
        { _id: order._id, status: { $in: OPEN_PRODUCTION_STATUSES } },
        {
          $set: {
            status: 'done',
            producedQty,
            extraCost,
            lotCode,
            expiresAt: dto.expiresAt,
            note: dto.note ?? order.note,
            completedAt: new Date(),
            completedByEmail: user.email,
            ...Object.fromEntries(
              order.lines.map((l, i) => [`lines.${i}.qtyConsumed`, l.qty]),
            ),
          },
        },
        { new: true },
      )
      .exec();
    if (!reserved) {
      // Otra llamada (o un reintento) ya cerró la orden: no re-consumir.
      return this.get(id, user);
    }

    // 3. Movimientos de inventario.
    let consumed: ConsumedLine[];
    try {
      consumed = await this.stock.consumeLines(
        'production_out',
        sedeId,
        order.lines.map((l) => ({
          productId: l.productId.toString(),
          qty: l.qty,
        })),
        user,
        { note: `Producción ${order.number}` },
      );
    } catch (err) {
      this.logger.error(
        `La orden ${order.number} quedó marcada como terminada pero el consumo de insumos falló: ${
          err instanceof Error ? err.message : String(err)
        }. Revisa el inventario y corrige con un ajuste.`,
      );
      throw err;
    }

    // Costeo: materiales al costo REAL de los lotes que salieron (no a un
    // promedio del catálogo), más el costo de conversión del lote.
    const lineCosts = consumed.map((line) =>
      sumBy(line.portions, (portion) =>
        cop(portion.qty * (portion.lot?.unitCost ?? line.product.cost ?? 0)),
      ),
    );
    const materialsCost = sumCop(lineCosts);
    const totalCost = cop(materialsCost + extraCost);
    const unitCost = cop(totalCost / producedQty);

    try {
      await this.stock.entry(
        {
          productId: order.productId.toString(),
          sedeId,
          qty: producedQty,
          unitCost,
          lotCode,
          expiresAt: dto.expiresAt,
          note: `Producción ${order.number}`,
        },
        user,
        { movementType: 'production_in' },
      );
    } catch (err) {
      this.logger.error(
        `La orden ${order.number} consumió los insumos pero el ingreso del terminado falló: ${
          err instanceof Error ? err.message : String(err)
        }. Ingrésalo con un ajuste positivo.`,
      );
      throw err;
    }

    reserved.materialsCost = materialsCost;
    reserved.totalCost = totalCost;
    reserved.unitCost = unitCost;
    reserved.lines.forEach((line, i) => {
      const cost = lineCosts[i] ?? 0;
      line.subtotal = cost;
      line.unitCost = line.qty > 0 ? cop(cost / line.qty) : 0;
    });
    await reserved.save();
    return reserved;
  }

  /** Falla con un mensaje accionable si algún insumo no alcanza en la sede. */
  private async assertMaterialsAvailable(
    order: ProductionOrderDocument,
    sedeId: string,
  ): Promise<void> {
    const missing: string[] = [];
    for (const line of order.lines) {
      const available = await this.stock.availableQty(
        line.productId.toString(),
        sedeId,
      );
      if (available < line.qty) {
        missing.push(
          `${line.description}: hay ${available} ${line.unit} y se necesitan ${line.qty}`,
        );
      }
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `No alcanzan los insumos en esta sede. ${missing.join('; ')}`,
      );
    }
  }

  /**
   * Resuelve los insumos de una orden: los que llegan explícitos, o la receta
   * del terminado explotada a prorrata de lo que se va a producir.
   */
  private async resolveLines(
    output: ProductDocument,
    plannedQty: number,
    explicit: ProductionLineDto[] | undefined,
    extraCost: number | undefined,
  ): Promise<{ lines: BuiltLine[]; extraCost: number; bomId?: Types.ObjectId }> {
    const build = async (
      raw: { productId: string; qty: number }[],
    ): Promise<BuiltLine[]> => {
      const seen = new Set<string>();
      const lines: BuiltLine[] = [];
      for (const line of raw) {
        if (line.productId === output._id.toString()) {
          throw new BadRequestException(
            `${output.name} no puede ser insumo de su propia orden`,
          );
        }
        if (seen.has(line.productId)) {
          throw new BadRequestException(
            'Hay un insumo repetido; súmalo en un solo renglón',
          );
        }
        seen.add(line.productId);
        const input = await this.products.getOrFail(line.productId);
        if (!input.active) {
          throw new BadRequestException(`El insumo ${input.name} está inactivo`);
        }
        const qty = qtyRound(line.qty);
        if (!(qty > 0)) {
          throw new BadRequestException(
            `La cantidad de ${input.name} debe ser mayor a 0`,
          );
        }
        lines.push({
          productId: input._id,
          // Snapshot legible: la orden debe entenderse dentro de un año aunque
          // el producto haya cambiado de nombre o salido del catálogo.
          description: `${input.name} · ${input.sku}`,
          unit: input.unit,
          qty,
          qtyConsumed: 0,
          unitCost: 0,
          subtotal: 0,
        });
      }
      return lines;
    };

    if (explicit && explicit.length > 0) {
      return { lines: await build(explicit), extraCost: cop(extraCost ?? 0) };
    }

    const bom = await this.bomForProduct(output._id.toString());
    if (!bom) {
      throw new BadRequestException(
        `${output.name} no tiene receta registrada: créala o envía los insumos de esta orden a mano`,
      );
    }
    if (!(bom.outputQty > 0)) {
      throw new BadRequestException(
        `La receta de ${output.name} rinde 0 unidades; corrígela antes de producir`,
      );
    }
    const factor = plannedQty / bom.outputQty;
    const lines = await build(
      bom.lines.map((l) => ({
        productId: l.productId.toString(),
        qty: qtyRound(l.qty * factor),
      })),
    );
    return {
      lines,
      extraCost: cop(extraCost ?? bom.extraCost * factor),
      bomId: bom._id,
    };
  }

  // ─── Puente Inventario → Producción → Productos ────────────────────────────

  /**
   * Tablero de terminados: una fila por receta con los tres eslabones de la
   * cadena a la vista.
   *
   *   insumos (Inventario) → receta (Producción) → vendible (Productos)
   *
   * Producción es el intermediario de ALGUNOS productos, no de todos: lo que se
   * compra ya hecho va derecho de Inventario a Productos y no aparece aquí.
   * Esta consulta responde lo único que ninguno de los otros dos módulos puede
   * responder por separado: cuánto cuesta fabricar una unidad y cuánto queda de
   * margen contra el precio al que se está vendiendo.
   *
   * El costo de referencia es el de la ÚLTIMA orden terminada —lo que de verdad
   * costó el último lote— y solo cae al costo teórico del catálogo cuando
   * todavía no se ha fabricado nunca.
   */
  async outputs(user: JwtUser, sedeId?: string): Promise<ProductionOutput[]> {
    if (sedeId) assertSedeAccess(user, sedeId);
    const boms = await this.listBoms();
    if (boms.length === 0) return [];

    const productIds = boms.map((b) => refId(b.productId));
    const [stockByProduct, sellables, lastOrders] = await Promise.all([
      this.stock.qtyByProduct(productIds, sedeId, allowedSedeIds(user)),
      this.catalog.listByInventoryProducts(productIds),
      this.lastCompletedByProduct(productIds),
    ]);

    return boms.map((bom) => {
      const product = bom.productId as unknown as ProductDocument | null;
      const productId = refId(bom.productId);
      const lines = bom.lines.map((l) => {
        const input = l.productId as unknown as ProductDocument | null;
        return {
          productId: refId(l.productId),
          sku: input?.sku ?? '',
          name: input?.name ?? 'Insumo eliminado',
          unit: input?.unit ?? '',
          qty: l.qty,
          // Costo teórico del insumo: el último de compra que guarda el ítem.
          unitCost: cop(input?.cost ?? 0),
          subtotal: cop(l.qty * (input?.cost ?? 0)),
        };
      });

      const materialsCost = sumBy(lines, (l) => l.subtotal);
      const estimatedUnitCost =
        bom.outputQty > 0
          ? cop((materialsCost + bom.extraCost) / bom.outputQty)
          : 0;

      const lastOrder = lastOrders.get(productId);
      const unitCost = lastOrder?.unitCost ?? estimatedUnitCost;
      const sellable = sellables.get(productId);
      const salePrice = sellable?.salePrice;

      return {
        bomId: bom._id.toString(),
        name: bom.name,
        outputQty: bom.outputQty,
        extraCost: bom.extraCost,
        lines,
        product: {
          _id: productId,
          sku: product?.sku ?? '',
          name: product?.name ?? bom.name,
          unit: product?.unit ?? 'und',
          itemType: product?.itemType ?? 'assembly',
          perishable: product?.perishable ?? false,
          active: product?.active ?? false,
        },
        stock: stockByProduct.get(productId) ?? 0,
        estimatedUnitCost,
        unitCost,
        lastOrder,
        sellable: sellable
          ? {
              _id: sellable._id.toString(),
              sku: sellable.sku,
              name: sellable.name,
              salePrice: sellable.salePrice,
              ivaRate: sellable.ivaRate,
              ivaType: sellable.ivaType,
              active: sellable.active,
            }
          : undefined,
        // El margen se mide contra el precio CON IVA que se cobra en caja, que
        // es el número que el dueño tiene en la cabeza. No es margen contable.
        margin: salePrice !== undefined ? cop(salePrice - unitCost) : undefined,
        marginPct:
          salePrice !== undefined && salePrice > 0
            ? Math.round(((salePrice - unitCost) / salePrice) * 100)
            : undefined,
      };
    });
  }

  /**
   * Saca el terminado a la venta creando su producto en el catálogo del POS.
   *
   * Se abastece del ítem de inventario (`sourceType: 'inventory'`, una unidad
   * por venta) y NO de una receta: lo que la caja descuenta es el terminado que
   * ya está en bodega, porque sus insumos se consumieron al fabricarlo. Montarlo
   * como receta descontaría la harina dos veces —al hornear y al vender— y
   * dejaría el pan fabricado eternamente en stock.
   */
  async publish(
    bomId: string,
    dto: PublishOutputDto,
  ): Promise<{ _id: string; sku: string; name: string; salePrice: number }> {
    const bom = await this.getBom(bomId);
    const productId = refId(bom.productId);
    const product = await this.products.getOrFail(productId);
    if (!product.active) {
      throw new BadRequestException(
        'El terminado está inactivo; actívalo en Inventario antes de venderlo',
      );
    }

    const existing = await this.catalog.listByInventoryProducts([productId]);
    if (existing.has(productId)) {
      throw new ConflictException(
        `${product.name} ya se vende en el POS; ajusta su precio desde Productos`,
      );
    }

    const created = await this.catalog.create({
      // En fuente inventario el SKU lo impone el ítem vinculado; se manda el
      // suyo para satisfacer el DTO y que quede idéntico pase lo que pase.
      sku: product.sku,
      name: product.name,
      salePrice: dto.salePrice,
      ivaRate: dto.ivaRate,
      ivaType: dto.ivaType,
      categoryId: dto.categoryId ?? product.categoryId?.toString(),
      sourceType: 'inventory',
      inventoryProductId: productId,
      qtyPerUnit: 1,
    });
    return {
      _id: created._id.toString(),
      sku: created.sku,
      name: created.name,
      salePrice: created.salePrice,
    };
  }

  /** Última orden terminada de cada producto, como mapa `productId -> orden`. */
  private async lastCompletedByProduct(
    productIds: string[],
  ): Promise<Map<string, LastProductionOrder>> {
    const rows = await this.orders.aggregate<{
      _id: Types.ObjectId;
      order: {
        _id: Types.ObjectId;
        number: string;
        date: string;
        completedAt?: Date;
        producedQty: number;
        unitCost: number;
        totalCost: number;
      };
    }>([
      {
        $match: {
          productId: { $in: productIds.map((id) => new Types.ObjectId(id)) },
          status: 'done',
        },
      },
      { $sort: { completedAt: -1 } },
      { $group: { _id: '$productId', order: { $first: '$$ROOT' } } },
    ]);
    return new Map(
      rows.map((r) => [
        r._id.toString(),
        {
          _id: r.order._id.toString(),
          number: r.order.number,
          date: r.order.date,
          completedAt: r.order.completedAt?.toISOString(),
          producedQty: r.order.producedQty,
          unitCost: r.order.unitCost,
          totalCost: r.order.totalCost,
        },
      ]),
    );
  }
}
