import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../infrastructure/schemas/sale.schema';
import {
  Counter,
  CounterDocument,
} from '../infrastructure/schemas/counter.schema';
import {
  StockItem,
  StockItemDocument,
} from '../../inventory/infrastructure/schemas/stock-item.schema';
import {
  CajaSession,
  CajaSessionDocument,
} from '../../caja/infrastructure/schemas/caja-session.schema';
import { StockService } from '../../inventory/application/stock.service';
import { ProductsService } from '../../inventory/application/products.service';
import { SedesService } from '../../sedes/application/sedes.service';
import { CatalogService } from '../../catalog/application/catalog.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { CreateSaleDto } from './dto/create-sale.dto';

@Injectable()
export class SalesService {
  constructor(
    @InjectModel(Sale.name)
    private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
    @InjectModel(StockItem.name)
    private readonly stockItemModel: Model<StockItemDocument>,
    @InjectModel(CajaSession.name)
    private readonly cajaSessionModel: Model<CajaSessionDocument>,
    private readonly stock: StockService,
    private readonly products: ProductsService,
    private readonly sedes: SedesService,
    private readonly catalog: CatalogService,
  ) {}

  /** El cajero solo opera sedes asignadas a su usuario (JWT). */
  private assertSedeAccess(sedeId: string, user: JwtUser): void {
    if (!user.sedeIds.includes(sedeId)) {
      throw new ForbiddenException('No tienes acceso a esta sede');
    }
  }

  /** Consecutivo por sede vía $inc atómico (no requiere transacciones). */
  private async nextSaleNumber(sedeId: string, sedeCode: string) {
    const counter = await this.counterModel
      .findOneAndUpdate(
        { _id: `sale:${sedeId}` },
        { $inc: { seq: 1 } },
        { upsert: true, new: true },
      )
      .exec();
    return `${sedeCode.toUpperCase()}-${String(counter.seq).padStart(6, '0')}`;
  }

  async create(
    dto: CreateSaleDto,
    user: JwtUser,
    orderId?: Types.ObjectId,
  ): Promise<SaleDocument> {
    this.assertSedeAccess(dto.sedeId, user);
    const sede = await this.sedes.findOrFail(dto.sedeId);

    // 1. Cargar los productos de catálogo vendidos (precio del servidor).
    const catalogById = new Map(
      await Promise.all(
        [...new Set(dto.lines.map((l) => l.productId))].map(
          async (id) =>
            [id, await this.catalog.loadSellableOrFail(id)] as const,
        ),
      ),
    );

    const lineTotals = dto.lines.map((line) => {
      const product = catalogById.get(line.productId)!;
      return {
        product,
        qty: line.qty,
        unitPrice: product.salePrice,
        lineTotal: product.salePrice * line.qty,
      };
    });
    const subtotal = lineTotals.reduce((sum, l) => sum + l.lineTotal, 0);

    // Descuento opcional (requiere permiso). Se acota a [0, subtotal].
    let discount: { type: 'amount' | 'percent'; value: number; amount: number } | undefined;
    let discountTotal = 0;
    if (dto.discount && dto.discount.value > 0) {
      if (!user.permissions.includes(PERMISSIONS.POS_DISCOUNT_AUTHORIZE)) {
        throw new ForbiddenException(
          'No tienes permiso para aplicar descuentos',
        );
      }
      const raw =
        dto.discount.type === 'percent'
          ? (subtotal * Math.min(dto.discount.value, 100)) / 100
          : dto.discount.value;
      discountTotal = Math.round(Math.min(Math.max(raw, 0), subtotal) * 100) / 100;
      discount = {
        type: dto.discount.type,
        value: dto.discount.value,
        amount: discountTotal,
      };
    }

    const taxTotal = 0;
    const total = subtotal - discountTotal + taxTotal;

    let received: number | undefined;
    let change: number | undefined;
    if (dto.payment.method === 'cash' && dto.payment.received !== undefined) {
      received = dto.payment.received;
      if (received < total) {
        throw new BadRequestException(
          'El monto recibido es menor que el total de la venta',
        );
      }
      change = received - total;
    }

    // 2. Explotar cada línea a su consumo de inventario y agregar por ítem.
    const demand = new Map<string, number>();
    for (const line of dto.lines) {
      const product = catalogById.get(line.productId)!;
      for (const c of this.catalog.componentsOf(product, line.qty)) {
        demand.set(c.productId, (demand.get(c.productId) ?? 0) + c.qty);
      }
    }
    const componentLines = [...demand.entries()].map(([productId, qty]) => ({
      productId,
      qty,
    }));
    if (componentLines.length === 0) {
      throw new BadRequestException(
        'Los productos vendidos no están enlazados al inventario',
      );
    }

    // 3. Pre-chequeo de stock (evita descuentos parciales en Mongo standalone).
    const items = await this.stockItemModel
      .find({ sedeId: new Types.ObjectId(dto.sedeId) })
      .exec();
    const stockByProduct = new Map(
      items.map((i) => [i.productId.toString(), i.qty]),
    );
    for (const c of componentLines) {
      const have = stockByProduct.get(c.productId) ?? 0;
      if (have < c.qty) {
        const prod = await this.products.getOrFail(c.productId);
        throw new BadRequestException(
          `Stock insuficiente de ${prod.name}: hay ${have} y se requieren ${c.qty}`,
        );
      }
    }

    // 4. Descuento FEFO + kardex 'sale' (una sola operación agregada).
    const sold = await this.stock.sell(dto.sedeId, componentLines, user);

    const components = componentLines.map((c, i) => {
      const soldLine = sold[i];
      const consumedLots = (soldLine?.portions ?? []).map((p) => ({
        lotId: p.lot?._id,
        qty: p.qty,
        unitCost: p.lot?.unitCost ?? 0,
      }));
      const cost = consumedLots.reduce(
        (sum, cl) => sum + cl.qty * cl.unitCost,
        0,
      );
      return {
        productId: soldLine?.product._id ?? new Types.ObjectId(c.productId),
        sku: soldLine?.product.sku ?? '',
        name: soldLine?.product.name ?? '',
        unit: soldLine?.product.unit ?? 'und',
        qty: c.qty,
        cost,
        consumedLots,
      };
    });

    // Si hay una caja abierta en la sede, la venta queda enlazada para el arqueo.
    const openCaja = await this.cajaSessionModel
      .findOne({ sedeId: new Types.ObjectId(dto.sedeId), status: 'open' })
      .exec();

    const saleNumber = await this.nextSaleNumber(dto.sedeId, sede.code);
    return this.saleModel.create({
      saleNumber,
      sedeId: new Types.ObjectId(dto.sedeId),
      cashierId: user.userId,
      cashierEmail: user.email,
      cajaSessionId: openCaja?._id,
      status: 'completed',
      lines: lineTotals.map((l) => ({
        productId: l.product._id,
        sku: l.product.sku,
        name: l.product.name,
        unit: 'und',
        qty: l.qty,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      })),
      components,
      subtotal,
      discount,
      discountTotal,
      taxTotal,
      total,
      payment: { method: dto.payment.method, received, change },
      customer: this.cleanCustomer(dto.customer),
      orderId,
    });
  }

  /** Descarta un customer vacío (sin ningún dato) para no guardar {} . */
  private cleanCustomer(customer?: CreateSaleDto['customer']) {
    if (!customer) return undefined;
    const entries = (['name', 'idNumber', 'phone', 'email'] as const)
      .map((k) => [k, customer[k]?.trim()] as const)
      .filter(([, v]) => v);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  /**
   * Anula una venta: la marca como 'void' y devuelve al inventario lo que
   * consumió (componentes de la venta; en ventas antiguas, las líneas).
   */
  async void(id: string, user: JwtUser): Promise<SaleDocument> {
    const sale = await this.getOrFail(id);
    const sedeId = (
      sale.sedeId as unknown as { _id: Types.ObjectId }
    )._id.toString();
    this.assertSedeAccess(sedeId, user);
    if (sale.status === 'void') {
      throw new BadRequestException('La venta ya está anulada');
    }

    const source = sale.components.length > 0 ? sale.components : sale.lines;
    const units = source.map((x) => ({
      productId: x.productId.toString(),
      qty: x.qty,
      consumedLots: (x.consumedLots ?? []).map((cl) => ({
        lotId: cl.lotId?.toString(),
        qty: cl.qty,
        unitCost: cl.unitCost,
      })),
    }));
    if (units.length > 0) {
      await this.stock.reverseSale(sedeId, units, user);
    }

    sale.status = 'void';
    await sale.save();
    return this.getOrFail(sale.id);
  }

  /** Ventas de una sede, paginadas (más recientes primero). */
  async list(sedeId: string, user: JwtUser, page = 1, limit = 20) {
    this.assertSedeAccess(sedeId, user);
    const filter = { sedeId: new Types.ObjectId(sedeId) };
    const capped = Math.min(Math.max(limit, 1), 100);
    const current = Math.max(page, 1);
    const [total, rows] = await Promise.all([
      this.saleModel.countDocuments(filter).exec(),
      this.saleModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((current - 1) * capped)
        .limit(capped)
        .populate('sedeId', 'code name')
        .exec(),
    ]);
    return { total, page: current, limit: capped, rows };
  }

  async getOrFail(id: string): Promise<SaleDocument> {
    const sale = Types.ObjectId.isValid(id)
      ? await this.saleModel
          .findById(id)
          .populate('sedeId', 'code name')
          .exec()
      : null;
    if (!sale) throw new NotFoundException('Venta no encontrada');
    return sale;
  }

  /**
   * Catálogo vendible del POS con la disponibilidad calculada en la sede:
   * cuántas unidades se pueden vender según el stock de sus componentes.
   */
  async posProducts(sedeId: string, user: JwtUser) {
    this.assertSedeAccess(sedeId, user);
    await this.sedes.findOrFail(sedeId);
    const [catalog, items] = await Promise.all([
      this.catalog.listSellable(),
      this.stockItemModel
        .find({ sedeId: new Types.ObjectId(sedeId) })
        .exec(),
    ]);
    const stockByProduct = new Map(
      items.map((i) => [i.productId.toString(), i.qty]),
    );
    return catalog.map((p) => {
      const components = this.catalog.componentsOf(p, 1);
      // Disponible = mínimo, entre sus componentes, de floor(stock / consumo).
      let available = components.length > 0 ? Infinity : 0;
      for (const c of components) {
        if (c.qty <= 0) continue;
        const have = stockByProduct.get(c.productId) ?? 0;
        available = Math.min(available, Math.floor(have / c.qty));
      }
      if (!Number.isFinite(available)) available = 0;

      const cat = p.categoryId as unknown as
        | { _id: Types.ObjectId; name: string }
        | null
        | undefined;
      return {
        _id: p._id,
        sku: p.sku,
        name: p.name,
        unit: 'und',
        salePrice: p.salePrice,
        stock: available,
        categoryId: cat?._id ? cat._id.toString() : null,
        categoryName: cat?.name ?? null,
      };
    });
  }
}
