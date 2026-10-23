import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../infrastructure/schemas/sale.schema';
import {
  SaleReturn,
  SaleReturnDocument,
} from '../infrastructure/schemas/sale-return.schema';
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
  CajaMovement,
  CajaMovementDocument,
} from '../../caja/infrastructure/schemas/caja-movement.schema';
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
import { PriceListsService } from '../../catalog/application/price-lists.service';
import { resolveUnitPrice } from '../../catalog/domain/price-list';
import { DeliveryZonesService } from '../../delivery/application/delivery-zones.service';
import {
  OrderType,
  ResolvedDelivery,
  resolveDelivery,
} from '../../delivery/domain/delivery.constants';
import { Sede } from '../../sedes/infrastructure/schemas/sede.schema';
import { CustomersService } from '../../customers/application/customers.service';
import { PayrollService } from '../../payroll/application/payroll.service';
import { ParamsService } from '../../core-params/application/params.service';
import { PEDIDO_DUPLICADO_CODE, esDuplicadoDePedido, fechaContablePedido } from '../domain/platform-orders';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { TreasuryPostingService } from '../../finance/treasury/treasury-posting.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { CreateSaleDto } from './dto/create-sale.dto';
import { TaxService } from '../../core-tax/application/tax.service';
import {
  causesInc,
  INC_RESTAURANTE_CODE,
  saleTaxFor,
  SaleTaxKind,
  SaleTaxProfile,
} from '../../core-tax/domain/sale-tax';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import {
  clampNonNegative,
  cop,
  sumBy,
} from '../../finance/domain/money.util';
import {
  chargeForQty,
  prorateCop,
  splitTaxIncluded,
} from '../domain/sale-amounts';
import {
  SplitPaymentError,
  SplitPaymentResult,
  cashAmountOf,
  hasCreditPart,
  PaymentDetail,
  detailOf,
  normalizeDetail,
  splitPayment,
  treasurySourceId,
  treasurySourceIds,
} from '../domain/sale-payments';
import { BusinessService } from '../../control/application/business.service';
import { offlineConflict } from './offline-conflict';
import { fechaContableOffline } from '../domain/offline-sales';
import type { BusinessType } from '../../control/domain/control.constants';

/** ¿El error de Mongo es el choque del índice único de `offlineId`? */
function esDuplicadoDeLlave(err: unknown): boolean {
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  return e?.code === 11000 && e.keyPattern?.offlineId !== undefined;
}

/** Opciones internas de `create` (no viajan en el DTO HTTP). */
export interface CreateSaleOptions {
  /**
   * Cuenta dividida: cantidad de cada producto ya cobrada en pagos anteriores
   * de la misma comanda. Con ella el bruto sale del acumulado y los cobros
   * suman exacto la cuenta.
   */
  paidBefore?: ReadonlyMap<string, number>;
  /**
   * Venta cobrada sin internet que llega al sincronizar (ítem 6.3). La arma
   * `OfflineSalesService`, que ya validó el número reservado y el candado de
   * idempotencia; aquí solo cambia de dónde salen el número, el turno y la
   * fecha, y los rechazos se devuelven como conflicto con su motivo.
   */
  offline?: OfflineSaleOptions;
}

export interface OfflineSaleOptions {
  offlineId: string;
  /** Consecutivo de contingencia reservado (`FVC-000123`). */
  saleNumber: string;
  /** Cuándo se cobró en el terminal. */
  soldAt: Date;
  /** Turno al que entra (el de la reserva o, a pedido, el abierto). */
  cajaSessionId: string;
  /** Lo que se le cobró al cliente según el comprobante impreso. */
  expectedGrandTotal: number;
  /** Turno (cerrado) de la reserva, si la venta entra al abierto a pedido. */
  turnoOrigenId?: string;
  /**
   * Registrar con lo cobrado (autorizado con `pos.void.authorize`): precio
   * unitario del comprobante por producto, producto inactivo y faltante de
   * stock registrado no la detienen.
   */
  override?: { byUserId: string; byEmail?: string; at: Date };
  chargedPrices?: Record<string, number>;
  /** Lo que no había en el inventario registrado (lo llena `create`). */
  faltantes?: FaltanteOffline[];
  /**
   * Quién cobró la venta: el dueño de la reserva. Si la registra quien
   * autoriza desde la bandeja, la venta sigue siendo del cajero; el
   * autorizador queda solo en `override`.
   */
  cajero?: { userId: string; email: string };
}

/** Lo vendido offline que no estaba en el inventario registrado, con su costo estimado. */
export interface FaltanteOffline {
  productId: string;
  qty: number;
  /** Último costo de compra del ítem al registrar la venta (COP). */
  unitCost: number;
  cost: number;
}

/** Un candado de llave más viejo que esto es de una petición que murió. */
const LLAVE_STALE_MS = 2 * 60_000;

/** Qué anuló cancelCredit, para poder devolverlo si la anulación se aborta. */
type FiadoCancelado = 'none' | 'receivable' | 'deduction';

/** Quién debe el fiado de una venta (o de la parte fiada de un cobro mixto). */
interface CreditoDeVenta {
  debtorType?: 'customer' | 'employee';
  customerId?: string;
  employeeId?: string;
  dueDate?: string;
}

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
    private readonly priceLists: PriceListsService,
    private readonly deliveryZones: DeliveryZonesService,
    private readonly customers: CustomersService,
    private readonly payroll: PayrollService,
    private readonly params: ParamsService,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly treasury: TreasuryPostingService,
    /**
     * Modelo referenciado por `populate`. Va EXPLÍCITO en cada populate porque
     * los modelos se compilan de forma perezosa sobre la base de cada empresa:
     * si el referenciado todavía no lo estaba, mongoose lanzaba
     * MissingSchemaError y la pantalla salía en 500 hasta que otra petición lo
     * compilara. Se declara al final para no mover el orden de los parámetros
     * ya existentes (varias pruebas construyen el servicio posicionalmente).
     */
    @InjectModel(Sede.name)
    private readonly sedeModel: Model<unknown>,
    /** Catálogo de impuestos: de aquí sale la tarifa vigente del INC. */
    private readonly tax: TaxService,
    /** Control-plane: el giro del negocio cuando el token no lo trae. */
    private readonly businesses: BusinessService,
    /**
     * Devoluciones de la venta: la anulación las consulta para no revertir dos
     * veces lo ya devuelto. Modelo y no `SaleReturnsService`, que depende de
     * este servicio (sería un ciclo).
     */
    @InjectModel(SaleReturn.name)
    private readonly saleReturnModel: Model<SaleReturnDocument>,
    /**
     * Movimientos de caja: anular una venta en efectivo de un turno ya cerrado
     * registra la salida del dinero en la caja abierta (ítem 1.12).
     */
    @InjectModel(CajaMovement.name)
    private readonly cajaMovementModel: Model<CajaMovementDocument>,
  ) {}

  /**
   * Giro del negocio activo, que decide si la venta causa INC o IVA. Lo trae
   * el claim `biztype` del token; los tokens emitidos antes de ese claim no lo
   * tienen, y sin giro un restaurante cobraría IVA 19 % en vez de INC 8 %. En
   * ese caso se lee de la empresa (igual que `AuthService.currentTipoNegocio`),
   * una vez por venta y no por línea.
   */
  private async tipoNegocio(): Promise<BusinessType | undefined> {
    const ctx = TenantContext.current();
    if (!ctx) return undefined;
    if (ctx.tipoNegocio) return ctx.tipoNegocio;
    const business = await this.businesses.findById(ctx.businessId);
    return business?.tipoNegocio;
  }

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
    opts: CreateSaleOptions = {},
  ): Promise<SaleDocument> {
    const key = opts.offline ? undefined : dto.idempotencyKey;
    if (!key) return this.crear(dto, user, orderId, opts);
    assertSedeAccess(user, dto.sedeId);
    const previa = await this.ventaPorLlave(key, dto.sedeId);
    if (previa) return previa;
    // Candado por la llave ANTES de numerar: dos envíos del mismo cobro a la
    // vez no gastan dos consecutivos FV- (la serie normal no puede tener
    // huecos) ni descuentan inventario dos veces.
    const ganadora = await this.tomarLlave(key, dto.sedeId);
    if (ganadora) return ganadora;
    try {
      return await this.crear(dto, user, orderId, opts);
    } finally {
      await this.counterModel
        .deleteOne({ _id: `idem:${key}` })
        .exec()
        .catch(() => undefined);
    }
  }

  /**
   * Toma el candado de una llave de cobro. Si otra petición lo tiene y no ha
   * terminado, 409 (el POS espera y reintenta); si ya terminó, su venta.
   */
  private async tomarLlave(key: string, sedeId: string): Promise<SaleDocument | null> {
    const id = `idem:${key}`;
    try {
      await this.counterModel.create({ _id: id, seq: Date.now() });
      return null;
    } catch (err) {
      if ((err as { code?: number })?.code !== 11000) throw err;
    }
    // Candado de una petición que murió: se toma.
    const viejo = await this.counterModel
      .findOneAndUpdate(
        { _id: id, seq: { $lt: Date.now() - LLAVE_STALE_MS } },
        { $set: { seq: Date.now() } },
      )
      .exec();
    if (viejo) return null;
    const venta = await this.ventaPorLlave(key, sedeId);
    if (venta) return venta;
    throw new ConflictException({
      code: 'COBRO_EN_PROCESO',
      message: 'Este cobro ya se está registrando. Espera un momento y revisa Ventas.',
    });
  }

  private async crear(
    dto: CreateSaleDto,
    user: JwtUser,
    orderId: Types.ObjectId | undefined,
    opts: CreateSaleOptions,
  ): Promise<SaleDocument> {
    assertSedeAccess(user, dto.sedeId);
    // Valida que la sede exista (lanza 404 si no). Su responsabilidad fiscal,
    // junto con el giro del negocio, decide qué impuesto lleva la venta.
    const sede = await this.sedes.findOrFail(dto.sedeId);

    const offline = opts.offline;
    // Cobro en línea reintentado (se perdió la respuesta): la llave ya tiene
    // venta y se devuelve esa, sin volver a descontar inventario ni cobrar.
    const idempotencyKey = offline ? undefined : dto.idempotencyKey;
    if (idempotencyKey) {
      const previa = await this.ventaPorLlave(idempotencyKey, dto.sedeId);
      if (previa) return previa;
    }

    // 0. Exigir caja abierta ANTES de tocar inventario: toda venta ocurre
    //    dentro de un turno de caja (integridad contable). Se enlaza al arqueo.
    const openCaja = await this.cajaSessionModel
      .findOne({
        sedeId: new Types.ObjectId(dto.sedeId),
        status: 'open',
        // La venta offline entra al turno de su reserva, no a cualquiera.
        ...(offline ? { _id: new Types.ObjectId(offline.cajaSessionId) } : {}),
      })
      .exec();
    if (!openCaja) {
      if (offline) {
        throw offlineConflict(
          'TURNO_CERRADO',
          'El turno de caja en el que se cobró esta venta ya se cerró',
        );
      }
      throw new BadRequestException(
        'Debes abrir la caja de la sede antes de registrar ventas',
      );
    }

    // Venta a crédito (fiado): exige un DEUDOR registrado ANTES de tocar
    // inventario — un cliente de la base (→ CxC) o un empleado (→ deducción de
    // nómina). El nombre suelto de la factura ya no basta para el fiado.
    //
    // Con cobro mixto (ítem 6.9) el fiado es UNA de las partes y su deudor
    // viaja en esa parte; las mismas reglas aplican a lo que se fía.
    await this.assertPedidoPlataforma(dto);
    const credito = this.creditoDe(dto);
    const isCredit = credito !== undefined;
    if (credito) {
      if (credito.debtorType === 'customer') {
        if (!credito.customerId) {
          throw new BadRequestException(
            'El fiado requiere seleccionar un cliente registrado',
          );
        }
      } else if (credito.debtorType === 'employee') {
        if (!credito.employeeId) {
          throw new BadRequestException(
            'El consumo a crédito requiere seleccionar un empleado',
          );
        }
        // Antes de vender ni tocar inventario: un empleado inexistente o
        // inactivo dejaría una venta fiada sin deducción.
        await this.payroll.assertEmpleadoParaConsumo(credito.employeeId);
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
          async (id) => {
            try {
              return [
                id,
                await this.catalog.loadSellableOrFail(
                  id,
                  // Autorizada con lo cobrado: un producto que se desactivó
                  // mientras no había red no impide registrar lo ya vendido.
                  offline?.override ? { allowInactive: true } : undefined,
                ),
              ] as const;
            } catch (err) {
              // Offline: el producto se vendió con el catálogo guardado y ya no
              // se puede vender (inactivo o borrado). La venta va a la bandeja.
              if (
                !offline ||
                !(err instanceof NotFoundException || err instanceof BadRequestException)
              ) {
                throw err;
              }
              throw offlineConflict(
                'PRODUCTO_INACTIVO',
                err instanceof Error ? err.message : 'Producto no disponible',
              );
            }
          },
        ),
      ),
    );

    /**
     * Qué lista de precios se cobra, de lo más explícito a lo más general:
     *
     *   1. La que el cajero eligió a mano en el terminal, para el cliente de
     *      paso que se lleva una caja. Eso es decidir cobrar menos, así que
     *      pide el mismo permiso que un descuento.
     *   2. La que el cliente REGISTRADO tiene asignada. Esa no pide permiso:
     *      no la está decidiendo el cajero, ya estaba pactada — y ese es el
     *      punto de todo esto, que el precio del mayorista no dependa de que
     *      alguien se acuerde de aplicarlo.
     *   3. Ninguna: precio de mostrador.
     *
     * Una lista desactivada no aplica aunque el cliente la tenga (lo resuelve
     * `rulesFor`): es la forma de dejar de vender a mayorista de un tirón.
     */
    let priceListId: string | undefined = dto.priceListId;
    if (priceListId) {
      if (!user.permissions.includes(PERMISSIONS.POS_DISCOUNT_AUTHORIZE)) {
        throw new ForbiddenException(
          'No tienes permiso para cambiar la lista de precios de una venta',
        );
      }
    } else {
      // El fiado identifica al deudor en `payment.customerId`; el resto de las
      // ventas, en `customerId`. La tienda que compra por cajas paga de
      // contado casi siempre, así que mirar solo el fiado dejaría la lista sin
      // aplicar justo en el caso que importa.
      const customerId = dto.customerId ?? credito?.customerId;
      if (customerId) {
        const cliente = await this.customers.getOrFail(customerId);
        priceListId = cliente.priceListId?.toString();
      }
    }
    const priceRules = await this.priceLists.rulesFor(priceListId);

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

    /*
     * Ítem 1.11: todo en COP entero. El bruto de cada línea se redondea a peso
     * (venta por peso o lista de precios dejan fracción) y, en una cuenta
     * dividida, sale del ACUMULADO cobrado de ese producto (`chargeForQty`):
     * tres tercios de $10.001 suman $10.001 y no $10.000.
     */
    const cobradoAntes = new Map(opts.paidBefore ?? []);
    const lineTotals = dto.lines.map((line) => {
      const product = catalogById.get(line.productId)!;
      // Offline autorizada con lo cobrado: manda el precio del comprobante
      // impreso (es el efectivo que entró al cajón), no el de hoy.
      const cobrado = offline?.override ? offline.chargedPrices?.[line.productId] : undefined;
      const unitPrice =
        cobrado !== undefined
          ? cop(cobrado)
          : resolveUnitPrice({
              basePrice: product.salePrice,
              qty: line.qty,
              catalogProductId: line.productId,
              list: priceRules,
            });
      const previo = cobradoAntes.get(line.productId) ?? 0;
      const gross = chargeForQty(unitPrice, previo, line.qty);
      cobradoAntes.set(line.productId, previo + line.qty);
      let discountAmount = 0;
      let discountName: string | undefined;
      if (line.discountId) {
        const d = discountsById.get(line.discountId)!;
        const raw =
          d.type === 'percent' ? (gross * Math.min(d.value, 100)) / 100 : d.value;
        discountAmount = cop(Math.min(Math.max(raw, 0), gross));
        discountName = d.name;
      }
      return {
        product,
        qty: line.qty,
        unitPrice,
        lineTotal: gross,
        discountAmount,
        discountName,
      };
    });
    const subtotal = sumBy(lineTotals, (l) => l.lineTotal);
    const lineDiscountTotal = sumBy(lineTotals, (l) => l.discountAmount);

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
      const saleLevel = cop(Math.min(Math.max(raw, 0), base));
      discountTotal = lineDiscountTotal + saleLevel;
      discount = {
        type: dto.discount.type,
        value: dto.discount.value,
        amount: saleLevel,
      };
    }

    // Qué impuesto lleva la venta: lo decide el régimen del negocio, no solo
    // el producto. Un restaurante cobra INC (2495) y no IVA; un no responsable
    // de IVA no discrimina impuesto (arts. 426, 437, 512-1 y 512-9 ET).
    const taxProfile: SaleTaxProfile = {
      tipoNegocio: await this.tipoNegocio(),
      responsabilidadFiscal: sede.responsabilidadFiscal,
      responsableIva: sede.responsableIva,
      responsableInc: sede.responsableInc,
      franquicia: sede.franquicia,
    };
    const incRate = causesInc(taxProfile)
      ? (await this.tax.resolveRate(INC_RESTAURANTE_CODE)).rate
      : 0;

    // Discriminación del impuesto (el precio YA lo incluye). El descuento de
    // venta se prorratea entre líneas según su neto antes de separar base +
    // impuesto. Todo en pesos: la suma de las partes del descuento es exacto
    // el descuento (el residuo cae al final) y en cada línea el impuesto es
    // `neto − base`, así Σ base + Σ impuesto = total sin un peso de más.
    const saleLevelDiscount = discountTotal - lineDiscountTotal;
    const saleShares = prorateCop(
      saleLevelDiscount,
      lineTotals.map((l) => l.lineTotal - l.discountAmount),
    );
    const linesWithTax = lineTotals.map((l, i) => {
      const finalNet = l.lineTotal - l.discountAmount - (saleShares[i] ?? 0);
      const { kind: taxKind, rate } = saleTaxFor(
        taxProfile,
        {
          ivaType: l.product.ivaType,
          ivaRate: l.product.ivaRate,
          tratamiento: l.product.tratamientoFiscal,
        },
        incRate,
      );
      const { base, tax: iva } = splitTaxIncluded(finalNet, rate);
      return {
        ...l,
        // `ivaRate` sigue siendo solo IVA: una línea con INC lo deja en 0.
        ivaRate: taxKind === 'iva' ? rate : 0,
        taxKind,
        taxRate: rate,
        taxBase: base,
        taxAmount: iva,
      };
    });
    const taxableBase = sumBy(linesWithTax, (l) => l.taxBase);
    const taxTotal = sumBy(linesWithTax, (l) => l.taxAmount);

    // El IVA está incluido en los precios: el total NO lo vuelve a sumar.
    const total = subtotal - discountTotal;

    // Propina voluntaria (restaurante): se cobra ENCIMA del total. No es venta
    // ni base gravable; el monto a pagar por el cliente es total + tip.
    const tip = clampNonNegative(dto.tip ?? 0);

    /*
     * Cobro del domicilio. Como la propina, se suma ENCIMA del total y no entra
     * a la base gravable —decisión tomada con el dueño—. A diferencia de la
     * propina sí es ingreso del negocio, así que sí va al libro contable.
     *
     * La tarifa la pone el SERVIDOR a partir de la zona; del navegador solo
     * viaja el id. El valor a mano existe para el pedido que no cae en ninguna
     * zona, que es la casilla que se acordó en vez de calcular por kilómetros.
     */
    const orderType = dto.orderType ?? (dto.platform ? 'llevar' : 'mostrador');
    let delivery: ResolvedDelivery | undefined;
    if (orderType === 'domicilio') {
      const zone = await this.deliveryZones.refFor(
        dto.delivery?.zoneId,
        dto.sedeId,
      );
      try {
        delivery = resolveDelivery(dto.delivery, zone);
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error ? err.message : 'Datos del domicilio inválidos',
        );
      }
    } else if (dto.delivery) {
      // Mandar dirección sin marcar domicilio casi siempre es que se escogió
      // mal el tipo de pedido. Cobrar el envío igual sería un cobro que nadie
      // pidió; ignorarlo en silencio, un domicilio que nadie va a entregar.
      throw new BadRequestException(
        'Para registrar una entrega, el pedido tiene que ser de tipo domicilio',
      );
    }
    const deliveryFee = cop(delivery?.fee ?? 0);

    const grandTotal = total + tip + deliveryFee;

    // Offline: el comprobante impreso dijo un total y ese es el efectivo que
    // entró al cajón. Si el servidor calcula otro (cambió un precio mientras
    // no había red), registrar la venta descuadraría la caja en silencio.
    if (offline && cop(offline.expectedGrandTotal) !== grandTotal) {
      throw offlineConflict(
        'TOTAL_DISTINTO',
        `El comprobante cobró ${cop(offline.expectedGrandTotal)} y hoy la venta vale ${grandTotal}`,
      );
    }

    let received: number | undefined;
    let change: number | undefined;
    // Cobro mixto: se valida el reparto ANTES de tocar inventario. Un reparto
    // que al juntar medios repetidos queda en uno solo se guarda como el pago
    // de siempre, sin `payments`.
    let cobro: SplitPaymentResult | undefined;
    if (dto.payments) {
      try {
        cobro = splitPayment(dto.payments, grandTotal, total + deliveryFee);
      } catch (err) {
        if (err instanceof SplitPaymentError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
      if (cobro.parts.some((p) => p.method === 'cash') || cobro.change > 0) {
        received = cobro.cashReceived;
        change = cobro.change;
      }
    } else if (dto.payment!.method === 'cash' && dto.payment!.received !== undefined) {
      // En pesos: el cambio que se entrega no puede llevar centavos (1.11).
      received = cop(dto.payment!.received);
      if (received < grandTotal) {
        throw new BadRequestException(
          'El monto recibido es menor que el total a pagar (incluye la propina)',
        );
      }
      change = received - grandTotal;
    }

    // El detalle del canal digital (ítem 6.4) también se valida ANTES de tocar
    // inventario: un canal que no es del medio es un 400, no una venta a medias.
    if (!dto.payments) {
      try {
        normalizeDetail(dto.payment!);
      } catch (err) {
        if (err instanceof SplitPaymentError) throw new BadRequestException(err.message);
        throw err;
      }
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
    const faltantes: FaltanteOffline[] = [];
    for (const c of componentLines) {
      const have = stockByProduct.get(c.productId) ?? 0;
      if (have < c.qty) {
        // Offline autorizada: la mercancía SÍ salió (se cobró y se entregó);
        // lo que falta es su registro. Se descuenta lo que hay y el resto queda
        // anotado en la venta para regularizar el inventario con un ajuste.
        if (offline?.override) {
          // Se costea al último costo de compra: entra al costo de ventas
          // contra la puente 143595 hasta que se regularice.
          const qtyFaltante = c.qty - Math.max(have, 0);
          const unitCost = cop((await this.products.getOrFail(c.productId)).cost ?? 0);
          faltantes.push({
            productId: c.productId,
            qty: qtyFaltante,
            unitCost,
            cost: cop(qtyFaltante * unitCost),
          });
          c.qty = Math.max(have, 0);
          continue;
        }
        const prod = await this.products.getOrFail(c.productId);
        const msg = `Stock insuficiente de ${prod.name}: hay ${have} y se requieren ${c.qty}`;
        if (offline) throw offlineConflict('SIN_STOCK', msg);
        throw new BadRequestException(msg);
      }
    }
    if (faltantes.length > 0) {
      for (let i = componentLines.length - 1; i >= 0; i--) {
        if (componentLines[i]!.qty <= 0) componentLines.splice(i, 1);
      }
    }

    /*
     * 3b. Empaque: la bolsa, el vaso, la cuchara. Se suma al consumo DESPUÉS
     * del pre-chequeo, a propósito.
     *
     * De dónde sale depende de `packagingExplicit`:
     *
     * - Con la bandera, manda EXCLUSIVAMENTE la lista que llegó del cobro, y
     *   una lista vacía significa "sin empaques": lo que cada producto declara
     *   en su ficha no se descuenta solo. Es la decisión de producto —el
     *   empaque que baja es el que se confirma al cobrar— y es la única forma
     *   de que "sin empaques" quiera decir algo.
     * - Sin la bandera (POS anterior a esta versión, o una cuenta que se
     *   liquida desde otro sitio), sigue el comportamiento de siempre: la
     *   ficha descuenta sola y la lista se suma encima.
     *
     * El empaque NUNCA puede tumbar una venta. Si el sistema cree que no hay
     * bolsas, casi siempre es que alguien no registró la compra, y las bolsas
     * físicamente están ahí: no poder cobrar una galleta por eso sería mucho
     * peor que el descuadre. Por eso se acota a lo que haya, se gasta hasta
     * donde alcance y el inventario se queda en cero en vez de irse a negativo.
     *
     * Va dentro del mismo consumo y no aparte para que su costo entre al de la
     * venta: el margen tiene que incluir la bolsa, que es justo lo que nadie
     * veía cuando el empaque solo bajaba con ajustes a mano.
     */
    const packagingDemand = new Map<string, number>();
    if (!dto.packagingExplicit) {
      for (const line of dto.lines) {
        const product = catalogById.get(line.productId)!;
        for (const p of this.catalog.packagingOf(product, line.qty)) {
          packagingDemand.set(
            p.productId,
            (packagingDemand.get(p.productId) ?? 0) + p.qty,
          );
        }
      }
    }
    for (const p of dto.packaging ?? []) {
      packagingDemand.set(
        p.productId,
        (packagingDemand.get(p.productId) ?? 0) + p.qty,
      );
    }
    /*
     * Memoria de la decisión, para poder sugerirla la próxima vez.
     *
     * Se guarda lo PEDIDO, no lo que alcanzó a descontarse: si las bolsas
     * figuran en cero porque nadie registró la compra, la venta salió igual en
     * bolsa y eso es lo que hay que recordar. El costo sigue saliendo de
     * `components`, así que guardar esto aparte no lo cuenta dos veces.
     */
    const packagingSnapshot: { productId: Types.ObjectId; name: string; qty: number }[] =
      [];
    for (const [productId, qty] of packagingDemand) {
      // El nombre es para poder leer la venta después; que no se pueda resolver
      // —ficha borrada, referencia vieja— no puede tumbar el cobro. Esto es
      // memoria, no contabilidad: el costo sale de `components`.
      let name = '';
      try {
        name = (await this.products.getOrFail(productId)).name;
      } catch {
        /* el ítem ya no existe: se guarda la cantidad sin nombre */
      }
      packagingSnapshot.push({
        productId: new Types.ObjectId(productId),
        name,
        qty,
      });
    }

    for (const [productId, pedida] of packagingDemand) {
      const disponible =
        (stockByProduct.get(productId) ?? 0) - (demand.get(productId) ?? 0);
      const gasta = Math.min(pedida, Math.max(disponible, 0));
      if (gasta <= 0) continue;
      const existente = componentLines.find((c) => c.productId === productId);
      if (existente) existente.qty += gasta;
      else componentLines.push({ productId, qty: gasta });
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
        packagingSnapshot,
        linesWithTax,
        subtotal,
        discount,
        discountTotal,
        taxableBase,
        taxTotal,
        total,
        tip,
        orderType,
        deliveryFee,
        delivery: delivery
          ? {
              ...delivery,
              zoneId: delivery.zoneId
                ? new Types.ObjectId(delivery.zoneId)
                : undefined,
            }
          : undefined,
        received,
        change,
        isCredit,
        credito,
        cobro,
        offline: offline ? { ...offline, faltantes } : undefined,
      });
    } catch (err) {
      // Carrera entre dos registros del mismo pedido de plataforma: gana el
      // primero (índice único) y este queda sin venta ni stock (se compensa abajo).
      if (dto.platform && esDuplicadoDePedido(err) && !holder.sale) {
        await this.rollbackSoldStock(dto.sedeId, components, user);
        throw new ConflictException({
          message: `El pedido ${dto.platform.externalId} de ${dto.platform.code} ya está registrado`,
          code: PEDIDO_DUPLICADO_CODE,
        });
      }
      // Dos envíos del mismo cobro a la vez: gana el primero (índice único de
      // `offlineId`); este devuelve su inventario y responde con esa venta.
      if (idempotencyKey && esDuplicadoDeLlave(err) && !holder.sale) {
        await this.rollbackSoldStock(dto.sedeId, components, user);
        const ganadora = await this.ventaPorLlave(idempotencyKey, dto.sedeId);
        if (ganadora) return ganadora;
      }
      // Solo compensamos si la venta NO alcanzó a persistirse; si ya existe,
      // el stock queda correctamente respaldado y el error es de un paso
      // posterior (best-effort) que no debe deshacer el inventario.
      if (!holder.sale) {
        await this.rollbackSoldStock(dto.sedeId, components, user);
      }
      throw err;
    }
  }

  /** La venta ya registrada con esta llave de idempotencia (u `offlineId`). */
  private async ventaPorLlave(
    key: string,
    sedeId: string,
  ): Promise<SaleDocument | null> {
    const venta = await this.saleModel.findOne({ offlineId: key }).exec();
    if (venta && venta.sedeId.toString() !== sedeId) {
      throw new ForbiddenException('Esa llave de cobro es de otra sede');
    }
    return venta;
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
    /** Con qué empaque salió, tal como se pidió (ver dónde se arma). */
    packagingSnapshot: { productId: Types.ObjectId; name: string; qty: number }[];
    linesWithTax: {
      product: { _id: Types.ObjectId; sku: string; name: string };
      qty: number;
      unitPrice: number;
      lineTotal: number;
      discountAmount: number;
      discountName?: string;
      ivaRate: number;
      taxKind: SaleTaxKind;
      taxRate: number;
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
    orderType: OrderType;
    deliveryFee: number;
    delivery?: {
      zoneId?: Types.ObjectId;
      zoneName?: string;
      address: string;
      phone?: string;
      notes?: string;
      courier?: string;
    };
    received?: number;
    change?: number;
    isCredit: boolean;
    /** Deudor del fiado (venta fiada o parte fiada de un cobro mixto). */
    credito?: CreditoDeVenta;
    /** Reparto del cobro mixto; sin él, `dto.payment` cubrió todo. */
    cobro?: SplitPaymentResult;
    /** Venta offline: número reservado, UUID y fecha original. */
    offline?: OfflineSaleOptions;
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
      orderType,
      deliveryFee,
      delivery,
      received,
      change,
      isCredit,
      credito,
      cobro,
      packagingSnapshot,
      offline,
    } = ctx;
    // La fecha contable es la del cobro: una venta offline sincronizada al
    // día siguiente pertenece al día en que se vendió.
    // Mismo criterio que los pedidos de plataforma: el día del cobro si es del
    // mes en curso; si el mes ya pasó (pudo cerrarse), hoy. `soldAt` se guarda
    // aparte como dato informativo.
    const fechaVenta = offline
      ? fechaContableOffline(fechaColombia(offline.soldAt), fechaColombia())
      : fechaColombia();
    // Mixto de verdad: más de un medio. Si al juntar quedó uno, es un pago de
    // siempre y se guarda igual que antes (sin `payments`).
    const mixto = cobro && cobro.parts.length > 1 ? cobro : undefined;
    const metodo = cobro ? cobro.primaryMethod : dto.payment!.method;
    // Detalle del canal digital (ítem 6.4) cuando el cobro fue de un solo medio.
    let detalle: PaymentDetail | undefined;
    if (cobro) detalle = cobro.primaryDetail;
    else {
      try {
        detalle = detailOf(normalizeDetail(dto.payment!));
      } catch (err) {
        if (err instanceof SplitPaymentError) throw new BadRequestException(err.message);
        throw err;
      }
    }

    const saleNumber = offline
      ? offline.saleNumber
      : await this.nextSaleNumber(dto.sedeId);
    const sale = await this.saleModel.create({
      saleNumber,
      sedeId: new Types.ObjectId(dto.sedeId),
      // Offline: quien cobró (dueño de la reserva), aunque la registre otro.
      cashierId: offline?.cajero?.userId ?? user.userId,
      cashierEmail: offline?.cajero?.email ?? user.email,
      cashierName:
        offline?.cajero && offline.cajero.userId !== user.userId ? undefined : user.name,
      seller: this.cleanSeller(dto.seller),
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
        taxKind: l.taxKind,
        taxRate: l.taxRate,
        taxBase: l.taxBase,
        taxAmount: l.taxAmount,
      })),
      components,
      packaging: packagingSnapshot,
      packagingExplicit: dto.packagingExplicit ?? false,
      subtotal,
      discount,
      discountTotal,
      taxableBase,
      taxTotal,
      total,
      tip,
      orderType,
      deliveryFee,
      delivery,
      payment: { method: metodo, received, change, ...detalle },
      payments: mixto?.parts,
      customer: this.cleanCustomer(dto.customer),
      orderId,
      // Offline: el UUID de la venta. En línea: la llave de idempotencia del
      // cobro, la misma que usaría la cola si el reintento sale sin red.
      offlineId: offline?.offlineId ?? dto.idempotencyKey,
      soldAt: offline?.soldAt,
      offlineTurnoOrigenId: offline?.turnoOrigenId
        ? new Types.ObjectId(offline.turnoOrigenId)
        : undefined,
      offlineOverride: offline?.override
        ? {
            ...offline.override,
            faltantes: (offline.faltantes ?? []).map((f) => ({
              productId: new Types.ObjectId(f.productId),
              qty: f.qty,
              unitCost: f.unitCost,
              cost: f.cost,
              status: 'pendiente' as const,
            })),
          }
        : undefined,
      platform: dto.platform
        ? {
            code: dto.platform.code,
            externalId: dto.platform.externalId.trim(),
            orderedAt: dto.platform.orderedAt,
            commissionEstimate: dto.platform.commissionEstimate,
            // Fecha del asiento: la del pedido si es del mes en curso, si no hoy.
            accountingDate: (
              fechaContablePedido(dto.platform.orderedAt, fechaColombia()) as { fecha: string }
            ).fecha,
          }
        : undefined,
    });
    // A partir de aquí la venta EXISTE: cierra la ventana de compensación de
    // stock (los pasos siguientes son best-effort y no revierten inventario).
    holder.sale = sale;

    // Venta a crédito (fiado): no entra a caja. Se rutea según el deudor.
    // Se debe lo mismo que el asiento debita a Clientes: total + domicilio. La
    // propina no se fía (es del personal y no pasa por el libro).
    if (isCredit && credito) {
      // En un cobro mixto se fía solo la parte a crédito.
      const fiado = cobro ? cobro.creditAmount : cop(total + deliveryFee);
      const today = fechaColombia();
      if (credito.debtorType === 'employee') {
        // Empleado → deducción de nómina (pendiente de aprobación). Aparecerá
        // en la colilla al aprobarse y correr la nómina.
        try {
          await this.payroll.createDeduction(
            {
              employeeId: credito.employeeId!,
              concept: `Consumo POS ${saleNumber}`,
              amount: fiado,
              date: today,
              source: 'sale',
              sourceId: sale._id.toString(),
            },
            user,
            { sinAlcanceDeSede: true },
          );
        } catch (err) {
          // Sin deducción la venta fiada no se cobra a nadie: se deshace la
          // venta (aún sin asiento ni tesorería) y se reabre la ventana de
          // compensación para que el llamador devuelva el stock.
          try {
            await this.saleModel.deleteOne({ _id: sale._id }).exec();
            holder.sale = undefined;
          } catch (errBorrado) {
            this.logger.error(
              `CONCILIAR: la venta ${sale._id.toString()} quedó fiada sin deducción de nómina y no se pudo deshacer: ${(errBorrado as Error).message}`,
            );
          }
          throw err;
        }
      } else {
        // Cliente registrado → cuenta por cobrar (CxC) enlazada a la venta.
        const customer = await this.customers.getOrFail(
          credito.customerId!,
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
          dueDate: credito.dueDate || this.addDays(today, diasGracia),
          amount: fiado,
          paidAmount: 0,
          status: 'open',
          payments: [],
          note: mixto ? 'Parte fiada de un cobro mixto' : 'Venta a crédito (fiado)',
          createdByEmail: user.email,
        });
      }
    }

    // Asiento contable de la venta (ingreso, IVA, INC y costo). Best-effort.
    // El INC va a su propia cuenta (2495) y el IVA a la suya (2408). Los dos
    // se suman con el MISMO criterio (sumBy por tipo): sacar el IVA como
    // el total redondeado menos el INC redondeaba dos veces y podía mandar un
    // peso de INC a la cuenta del IVA.
    const cogs = components.reduce((sum, c) => sum + (c.cost ?? 0), 0);
    const taxOf = (kind: SaleTaxKind) =>
      sumBy(
        linesWithTax.filter((l) => l.taxKind === kind),
        (l) => l.taxAmount,
      );
    const incTax = taxOf('inc');
    const ivaTax = taxOf('iva');
    await this.ledgerPosting.postSale({
      saleId: sale._id.toString(),
      number: saleNumber,
      date: sale.platform?.accountingDate ?? fechaVenta,
      sedeId: dto.sedeId,
      total,
      tax: ivaTax,
      consumptionTax: incTax,
      cogs: cop(cogs),
      faltanteCost: sumBy(offline?.faltantes ?? [], (f) => f.cost),
      // El domicilio es ingreso del negocio, sin IVA que separar.
      deliveryFee,
      // La propina entra con el cobro pero va al pasivo 2380 (ítem 1.10).
      tip: cop(sale.tip ?? 0),
      paymentMethod: metodo,
      // Cobro mixto: cada medio va a su cuenta (Caja, Bancos, Clientes).
      payments: mixto?.parts,
      onCredit: !mixto && isCredit,
      userEmail: user.email,
    });

    // Auto-posteo a tesorería: ventas con tarjeta/transferencia entran a la
    // cuenta bancaria mapeada de la sede. El efectivo NO (vive en la caja del
    // POS) y el fiado tampoco (crea CxC). Best-effort.
    //
    // Cobro mixto: un movimiento por medio bancario, por lo que ese medio
    // cubrió. El índice único de tesorería es por (sourceType, sourceId), así
    // que cada medio lleva su propio `sourceId` (ver `treasurySourceIds`).
    if (mixto) {
      for (const p of mixto.parts) {
        if (p.method !== 'card' && p.method !== 'transfer') continue;
        await this.treasury.post({
          sourceType: 'sale',
          sourceId: treasurySourceId(sale._id.toString(), p.method, true, p),
          sedeId: dto.sedeId,
          method: p.method,
          channel: p.channel,
          direction: 'in',
          amount: p.amount,
          date: fechaColombia(),
          concept: `Venta #${saleNumber} (pago mixto)`,
        });
      }
    } else if (metodo === 'card' || metodo === 'transfer') {
      await this.treasury.post({
        sourceType: 'sale',
        sourceId: sale._id.toString(),
        sedeId: dto.sedeId,
        method: metodo,
        channel: detalle?.channel,
        direction: 'in',
        // Lo que de verdad entró a la cuenta: el cliente pagó todo junto.
        amount: total + cop(sale.tip ?? 0) + deliveryFee,
        date: fechaColombia(),
        concept: `Venta #${saleNumber}`,
      });
    }

    return sale;
  }

  /**
   * Un pedido de plataforma (ítem 7.5) es `payment.method = 'platform'` MÁS el
   * dato `platform`; uno sin el otro no tiene sentido. Va ANTES de tocar el
   * inventario: el duplicado (mismo código en la misma plataforma) se rechaza
   * sin descontar stock. El índice único de la venta cubre la carrera.
   */
  private async assertPedidoPlataforma(dto: CreateSaleDto): Promise<void> {
    const esPlataforma =
      dto.payment?.method === 'platform' ||
      (dto.payments ?? []).some((p) => p.method === 'platform');
    if (!esPlataforma && !dto.platform) return;
    if (dto.payments) {
      throw new BadRequestException(
        'Un pedido de plataforma se registra con un solo medio de pago (platform), sin cobro mixto',
      );
    }
    if (dto.payment?.method !== 'platform' || !dto.platform) {
      throw new BadRequestException(
        'El medio de pago platform exige los datos del pedido de la plataforma (platform), y viceversa',
      );
    }
    if ((dto.tip ?? 0) > 0) {
      throw new BadRequestException(
        'Un pedido de plataforma no lleva propina en el POS: la plataforma la maneja',
      );
    }
    const fechaPedido = fechaContablePedido(dto.platform.orderedAt, fechaColombia());
    if ('error' in fechaPedido) throw new BadRequestException(fechaPedido.error);
    const externalId = dto.platform.externalId.trim();
    if (!externalId) {
      throw new BadRequestException('Falta el código del pedido de la plataforma');
    }
    const repetida = await this.saleModel
      .findOne({
        'platform.code': dto.platform.code,
        'platform.externalId': externalId,
        status: 'completed',
      })
      .select('saleNumber')
      .exec();
    if (repetida) {
      throw new ConflictException({
        message: `El pedido ${externalId} de ${dto.platform.code} ya está registrado (${repetida.saleNumber})`,
        code: PEDIDO_DUPLICADO_CODE,
      });
    }
  }

  /**
   * El deudor del fiado, si lo hay: el `payment` de siempre cuando es a
   * crédito, o la parte fiada de un cobro mixto. Además exige que venga uno
   * solo de `payment` y `payments`.
   */
  private creditoDe(dto: CreateSaleDto): CreditoDeVenta | undefined {
    if (dto.payments && dto.payment) {
      throw new BadRequestException(
        'Manda un solo medio de pago (payment) o el reparto (payments), no los dos',
      );
    }
    if (dto.payments) {
      return dto.payments.find((p) => p.method === 'credit');
    }
    if (!dto.payment) {
      throw new BadRequestException('La venta necesita un medio de pago');
    }
    return dto.payment.method === 'credit' ? dto.payment : undefined;
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
   * Vendedor sin nombre no es vendedor: se descarta, y la venta queda a nombre
   * de quien cobró, que es lo mismo que pasaba antes de existir el campo.
   */
  private cleanSeller(seller?: CreateSaleDto['seller']) {
    const name = seller?.name?.trim();
    if (!name) return undefined;
    return {
      name,
      employeeId: seller?.employeeId
        ? new Types.ObjectId(seller.employeeId)
        : undefined,
    };
  }

  /**
   * Anula una venta: la marca como 'void' y devuelve al inventario lo que
   * consumió (componentes de la venta; en ventas antiguas, las líneas).
   */
  async void(id: string, user: JwtUser): Promise<SaleDocument> {
    // Carga previa solo para validar el acceso por sede (y devolver 404 si no
    // existe). La anulación real se "toma" con un flip atómico más abajo.
    const existing = await this.getOrFail(id);
    const sedeId = (
      existing.sedeId as unknown as { _id: Types.ObjectId }
    )._id.toString();
    assertSedeAccess(user, sedeId);

    // Con devoluciones previas, anular revertiría otra vez el stock y el
    // ingreso de lo ya devuelto. Se rechaza en vez de anular solo el saldo: la
    // devolución ya es el camino para sacar lo que queda.
    const devoluciones = await this.saleReturnModel
      .countDocuments({ saleId: existing._id })
      .exec();
    if (devoluciones > 0) {
      throw new BadRequestException(
        'La venta tiene devoluciones registradas y no se puede anular: registra una devolución por lo que queda.',
      );
    }

    // Un pedido de plataforma ya liquidado dejó plata en el banco y una
    // comisión en el libro: se anula primero la liquidación, que devuelve el
    // pedido a «por cobrar».
    if (existing.platform?.settlementId) {
      throw new BadRequestException(
        'El pedido ya está liquidado con la plataforma: anula primero la liquidación.',
      );
    }

    // Venta en efectivo de un turno ya cerrado: su dinero se contó en ese
    // arqueo, así que devolverlo sale de la caja abierta hoy. Sin caja abierta
    // no hay dónde registrar la salida y el arqueo de mañana no cuadraría: se
    // rechaza antes de tocar nada (ítem 1.12).
    let cajaParaSalida: CajaSessionDocument | null = null;
    if (await this.esEfectivoDeTurnoCerrado(existing)) {
      cajaParaSalida = await this.cajaSessionModel
        .findOne({ sedeId: new Types.ObjectId(sedeId), status: 'open' })
        .exec();
      if (!cajaParaSalida) {
        throw new ConflictException(
          'La venta es de un turno ya cerrado y se pagó en efectivo: abre la caja para registrar la salida del dinero antes de anularla.',
        );
      }
    }

    // Guarda de concurrencia (Mongo standalone, sin transacciones): tomamos la
    // venta con un update condicional `status != 'void'`. Solo un llamador gana
    // el flip; si `findOneAndUpdate` devuelve null la venta ya estaba anulada,
    // así dos anulaciones simultáneas NO revierten el stock dos veces. Mismo
    // patrón atómico usado en otros flujos (checkout/deducciones).
    const sale = await this.saleModel
      .findOneAndUpdate(
        {
          _id: existing._id,
          status: { $ne: 'void' },
          // Una liquidación de plataforma que se coló entre la revisión de arriba
          // y este flip gana: el pedido ya no se puede anular.
          'platform.settlementId': { $exists: false },
        },
        { $set: { status: 'void' } },
        { new: true },
      )
      .exec();
    if (!sale) {
      throw new BadRequestException('La venta ya está anulada');
    }

    // Deshace el flip: la venta vuelve a 'completed' (solo si sigue 'void').
    const deshacerFlip = () =>
      this.saleModel
        .updateOne(
          { _id: sale._id, status: 'void' },
          { $set: { status: 'completed' } },
        )
        .exec();

    // Una devolución pudo registrarse entre la revisión de arriba y el flip.
    // Se vuelve a contar con la venta ya tomada: la devolución, a su vez,
    // revisa el estado de la venta después de crear su registro, así que en
    // cualquier orden al menos una de las dos se echa para atrás.
    const tardias = await this.saleReturnModel
      .countDocuments({ saleId: sale._id })
      .exec();
    if (tardias > 0) {
      await deshacerFlip();
      throw new BadRequestException(
        'La venta tiene devoluciones registradas y no se puede anular: registra una devolución por lo que queda.',
      );
    }

    // El fiado se cancela ANTES de revertir nada. Si no se puede (abonos o
    // nómina ya liquidada), la venta vuelve a 'completed' y no se movió nada.
    let fiado: FiadoCancelado;
    try {
      fiado = await this.cancelCredit(sale);
    } catch (err) {
      await deshacerFlip();
      throw err;
    }

    // A partir de aquí somos los dueños del flip: revertimos stock una sola vez.
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
      try {
        await this.stock.reverseSale(sedeId, units, user);
      } catch (err) {
        // Sin la reversa de stock la anulación no ocurrió: se devuelve el
        // fiado y la venta a como estaban, para que el reintento pueda volver
        // a anular (si no, diría «ya está anulada» con el asiento sin
        // reversar). El libro y la tesorería todavía no se tocaron.
        this.logger.error(
          `Anulación de la venta ${sale._id.toString()} abortada: falló la reversa de stock (${(err as Error).message}). Se deshace el fiado (${fiado}) y el flip.`,
        );
        await this.restoreCredit(sale, fiado);
        await deshacerFlip();
        throw err;
      }
    }

    // Reversa contable de la venta (contra-asiento).
    await this.ledgerPosting.reverseSale(sale._id.toString(), user.email);
    // Reversa del auto-posteo a tesorería (si la venta fue tarjeta/transferencia,
    // o tuvo partes así en un cobro mixto: una por medio).
    await this.treasury.reverse('sale', treasurySourceIds(sale._id.toString()));

    if (cajaParaSalida) {
      try {
        await this.cajaMovementModel.create({
          sessionId: cajaParaSalida._id,
          sedeId: new Types.ObjectId(sedeId),
          type: 'out',
          // Lo que el cliente dejó en efectivo (neto del vuelto): en una venta
          // de contado es total + propina + domicilio; en un cobro mixto, solo
          // la parte en efectivo.
          amount: cashAmountOf(sale),
          reason: 'Anulación de venta',
          note: `Venta ${sale.saleNumber} de un turno cerrado`,
          userId: user.userId,
          userEmail: user.email,
        });
      } catch (err) {
        this.logger.error(
          `CONCILIAR: la venta ${sale._id.toString()} se anuló pero no se registró la salida de efectivo en la caja ${cajaParaSalida._id.toString()}: ${(err as Error).message}`,
        );
      }
    }
    return this.getOrFail(sale.id);
  }

  /** Venta pagada en efectivo cuyo turno de caja ya se cerró (o no existe). */
  private async esEfectivoDeTurnoCerrado(sale: SaleDocument): Promise<boolean> {
    if (cashAmountOf(sale) <= 0 || !sale.cajaSessionId) return false;
    const turno = await this.cajaSessionModel.findById(sale.cajaSessionId).exec();
    return turno?.status !== 'open';
  }

  /**
   * Cancela lo que dejó un fiado: la CxC del cliente o el consumo en la nómina
   * del empleado (una venta tiene uno o el otro).
   *
   * Criterio conservador: solo se anula un fiado que nadie ha tocado. La CxC
   * se anula con un update condicionado a `paidAmount: 0`, así un abono que
   * llegue a la vez no se pierde; si ya tiene abonos se rechaza, porque esos
   * cobros tienen su asiento y su entrada a caja o banco, y anular solo el
   * saldo dejaría a medias una venta cuyo stock e ingreso sí se revierten
   * completos. El consumo ya descontado en nómina se rechaza por lo mismo.
   */
  private async cancelCredit(sale: SaleDocument): Promise<FiadoCancelado> {
    if (!hasCreditPart(sale)) return 'none';

    // La venta no guarda el tipo de deudor: el fiado a cliente deja una CxC
    // enlazada a la venta y el de empleado no. Por eso se mira la CxC primero
    // y la nómina solo se toca cuando no hay CxC.
    const anulada = await this.receivableModel
      .findOneAndUpdate(
        { saleId: sale._id, status: 'open', paidAmount: 0 },
        { $set: { status: 'void' } },
        { new: true },
      )
      .exec();
    if (anulada) return 'receivable';

    const cxc = await this.receivableModel.findOne({ saleId: sale._id }).exec();
    if (cxc) {
      if (cxc.status !== 'void') {
        throw new BadRequestException(
          `El fiado ya tiene abonos por $${cxc.paidAmount} de $${cxc.amount} y la venta no se puede anular. Registra una devolución o termina de cobrar la cuenta.`,
        );
      }
      // Ya estaba anulada desde antes: no es nuestra, no se restaura.
      return 'none';
    }

    // Fiado de empleado: el consumo en nómina.
    await this.payroll.cancelSaleDeduction(sale._id.toString());
    return 'deduction';
  }

  /**
   * Devuelve el fiado que cancelCredit anuló cuando la anulación se aborta más
   * adelante. La CxC solo vuelve a 'open' si sigue anulada y sin abonos.
   */
  private async restoreCredit(
    sale: SaleDocument,
    fiado: FiadoCancelado,
  ): Promise<void> {
    if (fiado === 'receivable') {
      await this.receivableModel
        .updateOne(
          { saleId: sale._id, status: 'void', paidAmount: 0 },
          { $set: { status: 'open' } },
        )
        .exec();
    } else if (fiado === 'deduction') {
      await this.payroll.restoreSaleDeduction(sale._id.toString());
    }
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
        .populate({ path: 'sedeId', select: 'code name', model: this.sedeModel })
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

  /**
   * La venta, solo si es de una sede del usuario (ítem 3.9). `GET /sales/:id`
   * devolvía la venta de cualquier sede a quien tuviera `pos.sell`.
   */
  async getForUser(id: string, user: JwtUser): Promise<SaleDocument> {
    const sale = await this.getOrFail(id);
    const sede = sale.sedeId as unknown as { _id?: Types.ObjectId } | null;
    assertSedeAccess(user, String(sede?._id ?? sede));
    return sale;
  }

  async getOrFail(id: string): Promise<SaleDocument> {
    const sale = Types.ObjectId.isValid(id)
      ? await this.saleModel
          .findById(id)
          .populate({ path: 'sedeId', select: 'code name', model: this.sedeModel })
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
      // Variante (talla / color): el POS agrupa por `variantGroupId` y usa
      // `variantAttrs` para pintar los botones de talla.
      const variant = this.catalog.variantInfoOf(p);
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
        // Foto del producto (Vercel Blob) para la rejilla del POS.
        imageUrl: p.imageUrl ?? null,
        barcode: this.catalog.barcodeOf(p),
        categoryId: cat?._id ? cat._id.toString() : null,
        categoryName: cat?.name ?? null,
        // Nulos en todo lo que no sea una variante, que es el caso normal.
        variantGroupId: variant?.groupId ?? null,
        variantGroupName: variant?.groupName ?? null,
        variantAttrs: variant?.attrs ?? null,
        variantAxes: variant?.axes ?? null,
      };
    });
  }
}
