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
  Product,
  ProductDocument,
} from '../../inventory/infrastructure/schemas/product.schema';
import {
  StockItem,
  StockItemDocument,
} from '../../inventory/infrastructure/schemas/stock-item.schema';
import { StockService } from '../../inventory/application/stock.service';
import { SedesService } from '../../sedes/application/sedes.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { CreateSaleDto } from './dto/create-sale.dto';

@Injectable()
export class SalesService {
  constructor(
    @InjectModel(Sale.name)
    private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockItem.name)
    private readonly stockItemModel: Model<StockItemDocument>,
    private readonly stock: StockService,
    private readonly sedes: SedesService,
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

  async create(dto: CreateSaleDto, user: JwtUser): Promise<SaleDocument> {
    this.assertSedeAccess(dto.sedeId, user);
    const sede = await this.sedes.findOrFail(dto.sedeId);

    // Validación de líneas con precio del servidor.
    const products = new Map<string, ProductDocument>();
    for (const line of dto.lines) {
      const product =
        products.get(line.productId) ??
        (await this.productModel.findById(line.productId).exec());
      if (!product) {
        throw new NotFoundException('Producto no encontrado');
      }
      if (!product.active || !product.salePrice || product.salePrice <= 0) {
        throw new BadRequestException(
          `${product.name} no está disponible para la venta`,
        );
      }
      products.set(line.productId, product);
    }

    const lineTotals = dto.lines.map((line) => {
      const product = products.get(line.productId)!;
      return {
        product,
        qty: line.qty,
        unitPrice: product.salePrice!,
        lineTotal: product.salePrice! * line.qty,
      };
    });
    const subtotal = lineTotals.reduce((sum, l) => sum + l.lineTotal, 0);
    const taxTotal = 0;
    const total = subtotal + taxTotal;

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

    // Descuento FEFO + kardex 'sale'. Si falta stock, lanza y no hay venta.
    const sold = await this.stock.sell(
      dto.sedeId,
      dto.lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      user,
    );

    const saleNumber = await this.nextSaleNumber(dto.sedeId, sede.code);
    return this.saleModel.create({
      saleNumber,
      sedeId: new Types.ObjectId(dto.sedeId),
      cashierId: user.userId,
      cashierEmail: user.email,
      status: 'completed',
      lines: lineTotals.map((l, i) => ({
        productId: l.product._id,
        sku: l.product.sku,
        name: l.product.name,
        unit: l.product.unit,
        qty: l.qty,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        consumedLots: (sold[i]?.portions ?? []).map((p) => ({
          lotId: p.lot?._id,
          qty: p.qty,
          unitCost: p.lot?.unitCost ?? 0,
        })),
      })),
      subtotal,
      taxTotal,
      total,
      payment: { method: dto.payment.method, received, change },
    });
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

  /** Catálogo vendible (activo y con precio) + stock de la sede. */
  async posProducts(sedeId: string, user: JwtUser) {
    this.assertSedeAccess(sedeId, user);
    await this.sedes.findOrFail(sedeId);
    const [products, items] = await Promise.all([
      this.productModel
        .find({ active: true, salePrice: { $gt: 0 } })
        .sort({ name: 1 })
        .populate('categoryId', 'name')
        .exec(),
      this.stockItemModel
        .find({ sedeId: new Types.ObjectId(sedeId) })
        .exec(),
    ]);
    const stockByProduct = new Map(
      items.map((i) => [i.productId.toString(), i.qty]),
    );
    return products.map((p) => {
      const cat = p.categoryId as unknown as
        | { _id: Types.ObjectId; name: string }
        | null
        | undefined;
      return {
        _id: p._id,
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        salePrice: p.salePrice,
        stock: stockByProduct.get(p._id.toString()) ?? 0,
        categoryId: cat?._id ? cat._id.toString() : null,
        categoryName: cat?.name ?? null,
      };
    });
  }
}
