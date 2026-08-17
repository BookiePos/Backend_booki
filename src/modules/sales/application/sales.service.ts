import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
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
import {
  Discount,
  DiscountDocument,
} from '../../discounts/infrastructure/schemas/discount.schema';
import {
  FinanceReceivable,
  FinanceReceivableDocument,
} from '../../finance/infrastructure/schemas/finance-receivable.schema';
import { StockService } from '../../inventory/application/stock.service';
import { ProductsService } from '../../inventory/application/products.service';
import { SedesService } from '../../sedes/application/sedes.service';
import { CatalogService } from '../../catalog/application/catalog.service';
import { CustomersService } from '../../customers/application/customers.service';
import { PayrollService } from '../../payroll/application/payroll.service';
import { ParamsService } from '../../core-params/application/params.service';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { TreasuryPostingService } from '../../finance/treasury/treasury-posting.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { CreateSaleDto } from './dto/create-sale.dto';

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    @InjectModel(Sale.name)
    private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
    @InjectModel(StockItem.name)
    private readonly stockItemModel: Model<StockItemDocument>,
    @InjectModel(CajaSession.name)
    private readonly cajaSessionModel: Model<CajaSessionDocument>,
    @InjectModel(Discount.name)
    private readonly discountModel: Model<DiscountDocument>,
    @InjectModel(FinanceReceivable.name)
    private readonly receivableModel: Model<FinanceReceivableDocument>,
    private readonly stock: StockService,
    private readonly products: ProductsService,
    private readonly sedes: SedesService,
    private readonly catalog: CatalogService,
    private readonly customers: CustomersService,
    private readonly payroll: PayrollService,
    private readonly params: ParamsService,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly treasury: TreasuryPostingService,
  ) {}

  /** Suma `days` días a una fecha YYYY-MM-DD y devuelve otra YYYY-MM-DD. */
  private addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('en-CA');
  }

  /**
   * Consecutivo por sede vía $inc atómico (no requiere transacciones).
   * Formato "FV-000123" (Factura de Venta): prefijo fijo + consecutivo, sin el
   * nombre de la sede en el número.
   */
  private async nextSaleNumber(sedeId: string) {
    const counter = await this.counterModel
      .findOneAndUpdate(
        { _id: `sale:${sedeId}` },
        { $inc: { seq: 1 } },
        { upsert: true, new: true },
      )
      .exec();
    return `FV-${String(counter.seq).padStart(6, '0')}`;
  }

  async create(
    dto: CreateSaleDto,
    user: JwtUser,
    orderId?: Types.ObjectId,
  ): Promise<SaleDocument> {
    assertSedeAccess(user, dto.sedeId);
    // Valida que la sede exista (lanza 404 si no).
    await this.sedes.findOrFail(dto.sedeId);

    // 0. Exigir caja abierta ANTES de tocar inventario: toda venta ocurre
    //    dentro de un turno de caja (integridad contable). Se enlaza al arqueo.
    const openCaja = await this.cajaSessionModel
      .findOne({ sedeId: new Types.ObjectId(dto.sedeId), status: 'open' })
      .exec();
    if (!openCaja) {
      throw new BadRequestException(
        'Debes abrir la caja de la sede antes de registrar ventas',
      );
    }

    // Venta a crédito (fiado): exige un DEUDOR registrado ANTES de tocar
    // inventario — un cliente de la base (→ CxC) o un empleado (→ deducción de
    // nómina). El nombre suelto de la factura ya no basta para el fiado.
    const isCredit = dto.payment.method === 'credit';
    if (isCredit) {
      if (dto.payment.debtorType === 'customer') {
        if (!dto.payment.customerId) {
          throw new BadRequestException(
            'El fiado requiere seleccionar un cliente registrado',
          );
        }
      } else if (dto.payment.debtorType === 'employee') {
        if (!dto.payment.employeeId) {
          throw new BadRequestException(
            'El consumo a crédito requiere seleccionar un empleado',
          );
        }
      } else {
        throw new BadRequestException(
          'Una venta a crédito requiere elegir un cliente registrado o un empleado',
        );
      }
    }

    // 1. Cargar los productos de catálogo vendidos (precio del servidor).
    const catalogById = new Map(
      await Promise.all(
        [...new Set(dto.lines.map((l) => l.productId))].map(
          async (id) =>
            [id, await this.catalog.loadSellableOrFail(id)] as const,
        ),
      ),
    );

    // Descuentos por línea: predefinidos de la sede. Aplicarlos requiere permiso.
    const lineDiscountIds = [
      ...new Set(
        dto.lines
          .map((l) => l.discountId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const discountsById = new Map<string, DiscountDocument>();
    const usesDiscounts = lineDiscountIds.length > 0 || Boolean(dto.discount);
    if (usesDiscounts && !user.permissions.includes(PERMISSIONS.POS_DISCOUNT_AUTHORIZE)) {
      throw new ForbiddenException('No tienes permiso para aplicar descuentos');
    }
    if (lineDiscountIds.length > 0) {
      const docs = await this.discountModel
        .find({
          _id: { $in: lineDiscountIds.map((id) => new Types.ObjectId(id)) },
          sedeId: new Types.ObjectId(dto.sedeId),
          active: true,
        })
        .exec();
      for (const d of docs) discountsById.set(d.id, d);
      for (const id of lineDiscountIds) {
        if (!discountsById.has(id)) {
          throw new BadRequestException(
            'Descuento no válido o inactivo para esta sede',
          );
        }
      }
    }

    const lineTotals = dto.lines.map((line) => {
      const product = catalogById.get(line.productId)!;
      const gross = product.salePrice * line.qty;
      let discountAmount = 0;
      let discountName: string | undefined;
      if (line.discountId) {
        const d = discountsById.get(line.discountId)!;
        const raw =
          d.type === 'percent' ? (gross * Math.min(d.value, 100)) / 100 : d.value;
        discountAmount = Math.round(Math.min(Math.max(raw, 0), gross) * 100) / 100;
        discountName = d.name;
      }
      return {
        product,
        qty: line.qty,
        unitPrice: product.salePrice,
        lineTotal: gross,
        discountAmount,
        discountName,
      };
    });
    const subtotal = lineTotals.reduce((sum, l) => sum + l.lineTotal, 0);
    const lineDiscountTotal = lineTotals.reduce(
      (sum, l) => sum + l.discountAmount,
      0,
    );

    // Descuento opcional a nivel de venta, sobre lo que queda tras descuentos de
    // línea. Se acota a [0, base].
    let discount: { type: 'amount' | 'percent'; value: number; amount: number } | undefined;
    let discountTotal = lineDiscountTotal;
    if (dto.discount && dto.discount.value > 0) {
      const base = subtotal - lineDiscountTotal;
      const raw =
        dto.discount.type === 'percent'
          ? (base * Math.min(dto.discount.value, 100)) / 100
          : dto.discount.value;
      const saleLevel =
        Math.round(Math.min(Math.max(raw, 0), base) * 100) / 100;
      discountTotal = lineDiscountTotal + saleLevel;
      discount = {
        type: dto.discount.type,
        value: dto.discount.value,
        amount: saleLevel,
      };
    }

    // Discriminación de IVA (el precio YA incluye IVA). El descuento de venta se
    // prorratea entre líneas según su neto antes de separar base + IVA.
    const saleLevelDiscount = discountTotal - lineDiscountTotal;
    const netSum = subtotal - lineDiscountTotal;
    const linesWithTax = lineTotals.map((l) => {
      const net = l.lineTotal - l.discountAmount;
      const saleShare = netSum > 0 ? (saleLevelDiscount * net) / netSum : 0;
      const finalNet = net - saleShare;
      const rate = l.product.ivaType === 'gravado' ? l.product.ivaRate : 0;
      const base =
        rate > 0
          ? Math.round((finalNet / (1 + rate / 100)) * 100) / 100
          : Math.round(finalNet * 100) / 100;
      const iva = Math.round((finalNet - base) * 100) / 100;
      return { ...l, ivaRate: rate, taxBase: base, taxAmount: iva };
    });
    const taxableBase =
      Math.round(linesWithTax.reduce((s, l) => s + l.taxBase, 0) * 100) / 100;
    const taxTotal =
      Math.round(linesWithTax.reduce((s, l) => s + l.taxAmount, 0) * 100) / 100;

    // El IVA está incluido en los precios: el total NO lo vuelve a sumar.
    const total = subtotal - discountTotal;

    // Propina voluntaria (restaurante): se cobra ENCIMA del total. No es venta
    // ni base gravable; el monto a pagar por el cliente es total + tip.
    const tip = Math.max(0, Math.round((dto.tip ?? 0) * 100) / 100);
    const grandTotal = Math.round((total + tip) * 100) / 100;

    let received: number | undefined;
    let change: number | undefined;
    if (dto.payment.method === 'cash' && dto.payment.received !== undefined) {
      received = dto.payment.received;
      if (received < grandTotal) {
        throw new BadRequestException(
          'El monto recibido es menor que el total a pagar (incluye la propina)',
        );
      }
      change = received - grandTotal;
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

    // El stock YA está descontado. En Mongo standalone (sin transacciones) no
    // podemos abortar atómicamente, así que si la CREACIÓN de la venta falla
    // (o cualquier paso previo a persistirla), compensamos devolviendo al
    // inventario lo consumido (contra-movimiento 'sale_void') y relanzamos.
    // Garantía: nunca queda stock descontado sin una venta que lo respalde.
    // Una vez la venta está persistida, los pasos derivados (CxC/deducción,
    // asientos, tesorería) ya NO revierten el stock: la venta existe y su
    // rectificación es una anulación (void), no un rollback silencioso.
    const holder: { sale?: SaleDocument } = {};
    try {
      return await this.finalizeSale(holder, {
        dto,
        user,
        orderId,
        openCaja,
        components,
        linesWithTax,
        subtotal,
        discount,
        discountTotal,
        taxableBase,
        taxTotal,
        total,
        tip,
        received,
        change,
        isCredit,
      });
    } catch (err) {
      // Solo compensamos si la venta NO alcanzó a persistirse; si ya existe,
      // el stock queda correctamente respaldado y el error es de un paso
      // posterior (best-effort) que no debe deshacer el inventario.
      if (!holder.sale) {
        await this.rollbackSoldStock(dto.sedeId, components, user);
      }
      throw err;
    }
  }

  /**
   * Devuelve al inventario el stock ya descontado de una venta que no llegó a
   * persistirse (compensación). Best-effort: cualquier fallo del rollback se
   * registra en el log para conciliación manual, sin ocultar el error original.
   */
  private async rollbackSoldStock(
    sedeId: string,
    components: {
      productId: Types.ObjectId;
      qty: number;
      consumedLots: { lotId?: Types.ObjectId; qty: number; unitCost?: number }[];
    }[],
    user: JwtUser,
  ): Promise<void> {
    try {
      const units = components.map((c) => ({
        productId: c.productId.toString(),
        qty: c.qty,
        consumedLots: (c.consumedLots ?? []).map((cl) => ({
          lotId: cl.lotId?.toString(),
          qty: cl.qty,
          unitCost: cl.unitCost,
        })),
      }));
      if (units.length > 0) {
        await this.stock.reverseSale(sedeId, units, user);
      }
    } catch (rollbackErr) {
      this.logger.error(
        `No se pudo revertir el stock descontado tras fallar la venta en la sede ${sedeId}; requiere conciliación manual`,
        rollbackErr instanceof Error ? rollbackErr.stack : String(rollbackErr),
      );
    }
  }

  /**
   * Persiste la venta y los pasos derivados (CxC/deducción, asientos, tesorería)
   * DESPUÉS de haber descontado el stock. Si algo aquí lanza, el llamador
   * compensa el stock ya descontado.
   */
  private async finalizeSale(
    holder: { sale?: SaleDocument },
    ctx: {
    dto: CreateSaleDto;
    user: JwtUser;
    orderId?: Types.ObjectId;
    openCaja: CajaSessionDocument;
    components: {
      productId: Types.ObjectId;
      sku: string;
      name: string;
      unit: string;
      qty: number;
      cost: number;
      consumedLots: { lotId?: Types.ObjectId; qty: number; unitCost: number }[];
    }[];
    linesWithTax: {
      product: { _id: Types.ObjectId; sku: string; name: string };
      qty: number;
      unitPrice: number;
      lineTotal: number;
      discountAmount: number;
      discountName?: string;
      ivaRate: number;
      taxBase: number;
      taxAmount: number;
    }[];
    subtotal: number;
    discount?: { type: 'amount' | 'percent'; value: number; amount: number };
    discountTotal: number;
    taxableBase: number;
    taxTotal: number;
    total: number;
    tip: number;
    received?: number;
    change?: number;
    isCredit: boolean;
  },
  ): Promise<SaleDocument> {
    const {
      dto,
      user,
      orderId,
      openCaja,
      components,
      linesWithTax,
      subtotal,
      discount,
      discountTotal,
      taxableBase,
      taxTotal,
      total,
      tip,
      received,
      change,
      isCredit,
    } = ctx;

    const saleNumber = await this.nextSaleNumber(dto.sedeId);
    const sale = await this.saleModel.create({
      saleNumber,
      sedeId: new Types.ObjectId(dto.sedeId),
      cashierId: user.userId,
      cashierEmail: user.email,
      cashierName: user.name,
      cajaSessionId: openCaja?._id,
      status: 'completed',
      lines: linesWithTax.map((l) => ({
        productId: l.product._id,
        sku: l.product.sku,
        name: l.product.name,
        unit: 'und',
        qty: l.qty,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        discountAmount: l.discountAmount,
        discountName: l.discountName,
        ivaRate: l.ivaRate,
        taxBase: l.taxBase,
        taxAmount: l.taxAmount,
      })),
      components,
      subtotal,
      discount,
      discountTotal,
      taxableBase,
      taxTotal,
      total,
      tip,
      payment: { method: dto.payment.method, received, change },
      customer: this.cleanCustomer(dto.customer),
      orderId,
    });
    // A partir de aquí la venta EXISTE: cierra la ventana de compensación de
    // stock (los pasos siguientes son best-effort y no revierten inventario).
    holder.sale = sale;

    // Venta a crédito (fiado): no entra a caja. Se rutea según el deudor.
    if (isCredit) {
      const today = new Date().toLocaleDateString('en-CA');
      if (dto.payment.debtorType === 'employee') {
        // Empleado → deducción de nómina (pendiente de aprobación). Aparecerá
        // en la colilla al aprobarse y correr la nómina.
        await this.payroll.createDeduction(
          {
            employeeId: dto.payment.employeeId!,
            concept: `Consumo POS ${saleNumber}`,
            amount: Math.round(total),
            date: today,
            source: 'sale',
            sourceId: sale._id.toString(),
          },
          user,
        );
      } else {
        // Cliente registrado → cuenta por cobrar (CxC) enlazada a la venta.
        const customer = await this.customers.getOrFail(
          dto.payment.customerId!,
        );
        // Vencimiento por defecto: hoy + días de gracia del fiado (parámetro).
        const diasGracia = await this.params.number(
          'finanzas.dias_gracia_cxc',
          30,
          { sedeId: dto.sedeId },
        );
        await this.receivableModel.create({
          sedeId: new Types.ObjectId(dto.sedeId),
          customerId: customer._id,
          customerName: customer.name,
          customerDoc: `${customer.docType} ${customer.docNumber}`,
          customerPhone: customer.phone,
          saleId: sale._id,
          docNumber: saleNumber,
          issueDate: today,
          dueDate: dto.payment.dueDate || this.addDays(today, diasGracia),
          amount: Math.round(total),
          paidAmount: 0,
          status: 'open',
          payments: [],
          note: 'Venta a crédito (fiado)',
          createdByEmail: user.email,
        });
      }
    }

    // Asiento contable de la venta (ingreso, IVA y costo). Best-effort.
    const cogs = components.reduce((sum, c) => sum + (c.cost ?? 0), 0);
    await this.ledgerPosting.postSale({
      saleId: sale._id.toString(),
      number: saleNumber,
      date: new Date().toLocaleDateString('en-CA'),
      sedeId: dto.sedeId,
      total: Math.round(total),
      tax: Math.round(taxTotal),
      cogs: Math.round(cogs),
      paymentMethod: dto.payment.method,
      onCredit: isCredit,
      userEmail: user.email,
    });

    // Auto-posteo a tesorería: ventas con tarjeta/transferencia entran a la
    // cuenta bancaria mapeada de la sede. El efectivo NO (vive en la caja del
    // POS) y el fiado tampoco (crea CxC). Best-effort.
    if (dto.payment.method === 'card' || dto.payment.method === 'transfer') {
      await this.treasury.post({
        sourceType: 'sale',
        sourceId: sale._id.toString(),
        sedeId: dto.sedeId,
        method: dto.payment.method,
        direction: 'in',
        amount: Math.round(total) + Math.round(sale.tip ?? 0),
        date: new Date().toLocaleDateString('en-CA'),
        concept: `Venta #${saleNumber}`,
      });
    }

    return sale;
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
    assertSedeAccess(user, sedeId);
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
    // Reversa contable de la venta (contra-asiento).
    await this.ledgerPosting.reverseSale(sale._id.toString(), user.email);
    // Reversa del auto-posteo a tesorería (si la venta fue tarjeta/transferencia).
    await this.treasury.reverse('sale', sale._id.toString());
    return this.getOrFail(sale.id);
  }

  /** Ventas de una sede, paginadas (más recientes primero). */
  async list(sedeId: string, user: JwtUser, page = 1, limit = 20) {
    assertSedeAccess(user, sedeId);
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

  /** Resumen de ventas de HOY en una sede: cantidad y total en dinero (sin anuladas). */
  async statsToday(
    sedeId: string,
    user: JwtUser,
  ): Promise<{ count: number; total: number }> {
    assertSedeAccess(user, sedeId);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const sales = await this.saleModel
      .find({
        sedeId: new Types.ObjectId(sedeId),
        status: 'completed',
        createdAt: { $gte: start },
      })
      .select('total')
      .exec();
    const total = sales.reduce((sum, s) => sum + s.total, 0);
    return { count: sales.length, total };
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
    assertSedeAccess(user, sedeId);
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
        barcode: this.catalog.barcodeOf(p),
        categoryId: cat?._id ? cat._id.toString() : null,
        categoryName: cat?.name ?? null,
      };
    });
  }
}
