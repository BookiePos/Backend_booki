import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  FinanceReceivable,
  FinanceReceivableDocument,
} from '../../finance/infrastructure/schemas/finance-receivable.schema';
import { NotaFiscalVentaService } from './nota-fiscal-venta.service';
import { SaldoFavorService } from './saldo-favor.service';
import type { NotaFiscalOperacion, SolicitudNotaVenta } from './emision-documento-fiscal.puerto';
import { origenNotaDevolucion, origenNotaRebaja } from '../domain/documento-fiscal';
import { hasCreditPart, propinaCobrada, salePartsOf } from '../domain/sale-payments';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SaleReturn,
  SaleReturnDocument,
} from '../infrastructure/schemas/sale-return.schema';
import { SaleDocument } from '../infrastructure/schemas/sale.schema';
import {
  NotaSinReferencia,
  NotaSinReferenciaDocument,
} from '../infrastructure/schemas/nota-sin-referencia.schema';
import { CreateSaleReturnDto } from './dto/create-sale-return.dto';
import { CreateSaleRebateDto } from './dto/create-sale-rebate.dto';
import {
  planDeRebaja,
  RebajaInvalidaError,
  type ProductoVendido,
  type YaReconocido,
} from '../domain/sale-rebate';
import { SalesService } from './sales.service';
import { CustomersService } from '../../customers/application/customers.service';
import { StockService } from '../../inventory/application/stock.service';
import { CatalogService } from '../../catalog/application/catalog.service';
import { CajaService } from '../../caja/application/caja.service';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import {
  buildReturnPlan,
  cogsForReturn,
  propinaDeDevolucion,
  prorateLots,
  ReturnPlan,
} from '../domain/sale-return';
import { clampNonNegative, cop, sumBy } from '../../finance/domain/money.util';
import type { SaleTaxKind } from '../../core-tax/domain/sale-tax';

/**
 * Devoluciones parciales de venta.
 *
 * Anular la venta completa ya existía (`SalesService.void`) y sigue siendo lo
 * correcto cuando el cliente devuelve TODO. Esto es para lo otro, que en una
 * tienda es lo normal: se llevó diez y trae dos.
 *
 * No reimplementa nada. El stock vuelve con `StockService.reverseSale` —el
 * mismo primitivo de la anulación, que respeta los lotes de los que salió—, la
 * merma con `adjust`, la plata con un movimiento de caja y el libro con el
 * mismo servicio de asientos. Aquí solo se decide QUÉ y CUÁNTO.
 */
/** Motivo de la devolución en llano, para la descripción de la nota. */
const MOTIVO_DEVOLUCION: Record<string, string> = {
  defectuoso: 'producto defectuoso',
  equivocado: 'producto equivocado',
  sobrante: 'compró de más',
  garantia: 'garantía',
  otro: 'otro motivo',
};

@Injectable()
export class SaleReturnsService {
  private readonly logger = new Logger('SaleReturns');

  constructor(
    @InjectModel(SaleReturn.name)
    private readonly model: Model<SaleReturnDocument>,
    private readonly sales: SalesService,
    private readonly stock: StockService,
    private readonly catalog: CatalogService,
    private readonly caja: CajaService,
    private readonly ledgerPosting: LedgerPostingService,
    /**
     * Cuentas por cobrar: la devolución de una venta fiada baja la cartera
     * (Fase 6B). Opcionales y al final para no mover las pruebas existentes.
     */
    @Optional()
    @InjectModel(FinanceReceivable.name)
    private readonly receivables?: Model<FinanceReceivableDocument>,
    /** Nota crédito / de ajuste de la devolución (Fase 6B). */
    @Optional()
    private readonly notas?: NotaFiscalVentaService,
    /**
     * Notas sin referencia (Fase 6C): lo que le asignaron a esta venta cuenta
     * como rebajado (tope cruzado).
     */
    @Optional()
    @InjectModel(NotaSinReferencia.name)
    private readonly sinReferencia?: Model<NotaSinReferenciaDocument>,
    /** Saldo a favor por cliente (Fase 6C): lo que la 2805 le acredita. */
    @Optional()
    private readonly saldoFavor?: SaldoFavorService,
    /** Cliente indicado en la devolución (Fase 6D): existe en la empresa. */
    @Optional()
    private readonly customers?: CustomersService,
  ) {}

  /** Devoluciones ya registradas de una venta, de la más reciente atrás. */
  async listForSale(
    saleId: string,
    user: JwtUser,
  ): Promise<SaleReturnDocument[]> {
    const sale = await this.sales.getOrFail(saleId);
    assertSedeAccess(user, this.sedeIdOf(sale));
    return this.model.find({ saleId: sale._id }).sort({ createdAt: -1 }).exec();
  }

  private sedeIdOf(sale: SaleDocument): string {
    const sede = sale.sedeId as unknown as { _id?: Types.ObjectId };
    return (sede?._id ?? (sale.sedeId as unknown as Types.ObjectId)).toString();
  }

  /**
   * Cuánto se devolvió ya de cada producto en esta venta.
   *
   * Sin esto, devolver 2 de 10 se podría repetir sin fin: cada devolución por
   * separado pasaría la validación y el cliente saldría con más plata de la que
   * puso.
   */
  private async alreadyReturned(saleId: Types.ObjectId): Promise<{
    qty: Map<string, number>;
    money: Map<string, { refund: number; refundTax: number }>;
    /** Lo que ya volvió de cada ítem de inventario (ítem 1.16). */
    components: Map<string, number>;
    /** Reembolso de productos y propina ya devueltos (decisión 4). */
    refundTotal: number;
    tipRefund: number;
    /** Rebajas posteriores ya reconocidas por producto (Fase 6C), aparte. */
    rebated: Map<string, { amount: number; tax: number }>;
  }> {
    const todas = await this.model.find({ saleId }).exec();
    // Las rebajas no devuelven unidades ni propina: van en su propio mapa y
    // bajan lo pagado de la devolución que sigue (`refundForLine`).
    const rebated = new Map<string, { amount: number; tax: number }>();
    for (const r of todas.filter((x) => x.kind === 'rebaja')) {
      for (const l of r.lines) {
        const key = l.productId.toString();
        const m = rebated.get(key) ?? { amount: 0, tax: 0 };
        rebated.set(key, { amount: m.amount + (l.refund ?? 0), tax: m.tax + (l.refundTax ?? 0) });
      }
    }
    // Lo que una nota sin referencia le asignó a esta venta (tope cruzado,
    // Fase 6C) es una rebaja más de cada producto.
    if (this.sinReferencia) {
      const notas = await this.sinReferencia.find({ 'asignaciones.saleId': saleId }).exec();
      for (const n of notas) {
        for (const a of n.asignaciones ?? []) {
          if (String(a.saleId) !== String(saleId)) continue;
          const m = rebated.get(a.productId) ?? { amount: 0, tax: 0 };
          rebated.set(a.productId, { amount: m.amount + (a.amount ?? 0), tax: m.tax + (a.tax ?? 0) });
        }
      }
    }
    const previas = todas.filter((x) => x.kind !== 'rebaja');
    const qty = new Map<string, number>();
    // La plata ya devuelta por línea: la última devolución salda exacto lo
    // que falte de lo pagado (ítem 1.11), sin pesos colgando.
    const money = new Map<string, { refund: number; refundTax: number }>();
    const components = new Map<string, number>();
    let refundTotal = 0;
    let tipRefund = 0;
    for (const p of previas) {
      refundTotal += p.refundTotal ?? 0;
      tipRefund += p.tipRefund ?? 0;
      for (const c of p.components ?? []) {
        const key = c.productId.toString();
        components.set(key, (components.get(key) ?? 0) + c.qty);
      }
      for (const l of p.lines) {
        const key = l.productId.toString();
        qty.set(key, (qty.get(key) ?? 0) + l.qty);
        const m = money.get(key) ?? { refund: 0, refundTax: 0 };
        money.set(key, {
          refund: m.refund + (l.refund ?? 0),
          refundTax: m.refundTax + (l.refundTax ?? 0),
        });
      }
    }
    return { qty, money, components, refundTotal, tipRefund, rebated };
  }

  /**
   * Traduce lo que devolvió el cliente a movimientos de inventario.
   *
   * Un producto vendible puede consumir varios ítems de inventario (una receta),
   * así que devolver dos hamburguesas devuelve pan, carne y queso. La receta se
   * lee del catálogo de HOY, pero el resultado se ACOTA a lo que la venta
   * consumió de verdad: si alguien editó la receta entre la venta y la
   * devolución, sin ese tope entraría al inventario mercancía que nunca salió.
   * El tope descuenta lo que ya volvió en devoluciones anteriores (ítem 1.16):
   * si no, dos devoluciones con la receta inflada metían el doble.
   */
  private async unitsToReturn(
    sale: SaleDocument,
    plan: ReturnPlan,
    yaVolvio: ReadonlyMap<string, number>,
  ) {
    const demand = new Map<string, number>();
    for (const l of plan.lines) {
      const product = await this.catalog
        .loadSellableOrFail(l.productId)
        .catch(() => null);
      if (!product) {
        throw new BadRequestException(
          'Un producto de la venta ya no está en el catálogo: anula la venta completa o corrige el inventario con un ajuste',
        );
      }
      for (const c of this.catalog.componentsOf(product, l.qty)) {
        demand.set(c.productId, (demand.get(c.productId) ?? 0) + c.qty);
      }
    }

    const units: {
      productId: string;
      qty: number;
      consumedLots: { lotId?: string; qty: number; unitCost?: number }[];
    }[] = [];
    for (const [productId, pedida] of demand) {
      const componente = sale.components.find(
        (c) => c.productId.toString() === productId,
      );
      if (!componente) continue; // no salió de aquí: no puede volver aquí
      const qty = Math.min(pedida, componente.qty - (yaVolvio.get(productId) ?? 0));
      if (qty <= 0) continue;
      units.push({
        productId,
        qty,
        consumedLots: prorateLots(
          (componente.consumedLots ?? []).map((cl) => ({
            lotId: cl.lotId?.toString(),
            qty: cl.qty,
            unitCost: cl.unitCost,
          })),
          componente.qty,
          qty,
        ),
      });
    }
    return units;
  }

  /** Cuánto dura el turno de quien completa una devolución (N1, N5). */
  static readonly TURNO_MS = 5 * 60 * 1000;
  /** Antigüedad a partir de la cual el barrido toma una devolución varada (N2). */
  static readonly VARADA_MS = 10 * 60 * 1000;

  async create(
    saleId: string,
    dto: CreateSaleReturnDto,
    user: JwtUser,
  ): Promise<SaleReturnDocument> {
    const sale = await this.sales.getOrFail(saleId);
    const sedeId = this.sedeIdOf(sale);
    assertSedeAccess(user, sedeId);

    if (sale.status === 'void') {
      throw new BadRequestException(
        'La venta está anulada: ya se devolvió completa',
      );
    }

    // Venta offline con faltante de stock (ítem 6.3): una devolución parcial
    // no revierte la cuenta puente 143595 ni sabe si ese stock ya se
    // regularizó. Pendiente, se anula la venta; regularizado, el ajuste de
    // inventario es el camino.
    if ((sale.offlineOverride?.faltantes ?? []).some((f) => f.status !== 'anulado')) {
      throw new ConflictException(
        'La venta se registró sin conexión con faltante de stock: no admite devoluciones. Si el faltante sigue pendiente, anula la venta; si ya se regularizó, registra un ajuste de inventario.',
      );
    }

    if (sale.platform) {
      // La plataforma es quien le devuelve la plata al cliente y ajusta lo que
      // le paga al negocio: una devolución aquí descuadraría la cuenta por
      // cobrar frente a su liquidación. Mientras no se liquide, se anula el
      // pedido; si ya se liquidó, el ajuste se hace con la plataforma.
      throw new BadRequestException(
        'Es un pedido de plataforma: las devoluciones las maneja la plataforma. Si no está liquidado, anula el pedido.',
      );
    }

    // Reintento de la MISMA devolución (llave del cliente): se devuelve la que
    // ya quedó, con su nota, en vez de devolver otra vez.
    const llave = dto.idempotencyKey?.trim() || undefined;
    if (llave) {
      const previa = await this.model.findOne({ saleId: sale._id, idempotencyKey: llave }).exec();
      if (previa) return this.reanudar(previa, sale, user, mismaCarga(previa, dto));
    }

    // Fiado a un EMPLEADO (consumo descontado por nómina): no hay cartera que
    // bajar y la deducción no admite rebaja parcial. Devolver plata dejaría al
    // empleado pagando lo que devolvió; se rechaza (fallar cerrado).
    const fiada = hasCreditPart(sale);
    const cxc = fiada ? await this.cuentaPorCobrar(sale) : null;
    if (fiada && this.receivables && !cxc) {
      throw new ConflictException(
        'La venta se fió a un empleado (descuento por nómina): no admite devoluciones parciales. Anula la venta completa.',
      );
    }
    const clienteId = await this.resolverCliente(dto.customerId, sale, cxc);
    this.assertTerceroParaSaldo(dto.refundMethod, sale, cxc, clienteId);

    const yaDevuelto = await this.alreadyReturned(sale._id);
    let plan: ReturnPlan;
    try {
      plan = buildReturnPlan(
        sale.lines.map((l) => ({
          productId: l.productId.toString(),
          qty: l.qty,
          taxBase: l.taxBase,
          taxAmount: l.taxAmount,
        })),
        dto.lines,
        yaDevuelto.qty,
        yaDevuelto.money,
        yaDevuelto.rebated,
      );
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Devolución inválida',
      );
    }

    const units = await this.unitsToReturn(sale, plan, yaDevuelto.components);

    // La propina vuelve en proporción a lo devuelto (decisión 4), con el
    // mismo redondeo acumulado que el reembolso: la última devolución la
    // salda entera. Va aparte de `refundTotal`, que es solo de productos.
    const tipRefund = propinaDeDevolucion({
      propina: propinaCobrada(sale),
      vendido: sumBy(sale.lines, (l) => l.taxBase + l.taxAmount),
      devueltoAntes: yaDevuelto.refundTotal,
      devueltoAhora: plan.refundTotal,
      propinaAntes: yaDevuelto.tipRefund,
    });

    // El costo de venta que deshace cada ítem que vuelve, con redondeo
    // acumulado sobre lo ya devuelto (ítem 1.16). Si se va a merma NO se
    // deshace: el inventario se perdió igual. Pero igual cuenta como devuelto,
    // para que las siguientes no se repartan su parte del costo.
    const components = units.map((u) => {
      const componente = sale.components.find(
        (c) => c.productId.toString() === u.productId,
      );
      const cogs =
        dto.restock === 'inventory' && componente
          ? cogsForReturn(
              componente.cost ?? 0,
              componente.qty,
              yaDevuelto.components.get(u.productId) ?? 0,
              u.qty,
            )
          : 0;
      return { productId: new Types.ObjectId(u.productId), qty: u.qty, cogs };
    });
    const porNombre = new Map(
      sale.lines.map((l) => [l.productId.toString(), l]),
    );

    /*
     * El registro se crea ANTES de mover nada, y el orden importa.
     *
     * Si se movieran primero el stock y la plata, un fallo al guardar dejaría
     * una devolución hecha pero no registrada: `alreadyReturned` no la vería y
     * el mismo cliente podría devolver lo mismo otra vez, cobrando dos veces.
     * Al revés, un fallo después deja un registro con el inventario sin
     * cuadrar: eso se ve y se arregla con un ajuste. Es el mismo criterio con
     * el que producción reserva el cierre antes de consumir.
     */
    let registro: SaleReturnDocument;
    try {
      registro = await this.model.create({
      idempotencyKey: llave,
      customerId: clienteId ? new Types.ObjectId(clienteId) : undefined,
      saleId: sale._id,
      saleNumber: sale.saleNumber,
      sedeId: new Types.ObjectId(sedeId),
      lines: plan.lines.map((l) => {
        const vendida = porNombre.get(l.productId);
        return {
          productId: new Types.ObjectId(l.productId),
          sku: vendida?.sku ?? '',
          name: vendida?.name ?? '',
          qty: l.qty,
          refund: l.refund,
          refundTax: l.refundTax,
        };
      }),
      components,
      reason: dto.reason,
      restock: dto.restock,
      wasteRecorded: false,
      // Pasos (D1): un reintento con la misma llave completa lo que falte.
      estado: 'en_curso',
      // Nace con el turno de quien la crea (N1): un doble clic con la misma
      // llave no puede entrar a completarla mientras esta petición sigue.
      procesandoHasta: new Date(Date.now() + SaleReturnsService.TURNO_MS),
      carteraHecha: false,
      stockHecho: false,
      cajaHecha: false,
      asientoHecho: false,
      refundMethod: dto.refundMethod,
      refundTotal: plan.refundTotal,
      refundTax: plan.refundTax,
      tipRefund,
      note: dto.note?.trim() || undefined,
      userId: user.userId,
      userEmail: user.email,
    });
    } catch (err) {
      // Dos reintentos simultáneos con la misma llave: gana uno y el otro lo devuelve.
      if (llave && (err as { code?: number })?.code === 11000) {
        const ganadora = await this.model.findOne({ saleId: sale._id, idempotencyKey: llave }).exec();
        if (ganadora) return this.reanudar(ganadora, sale, user, mismaCarga(ganadora, dto));
      }
      throw err;
    }

    // Una anulación pudo tomar la venta entre la revisión de arriba y el
    // registro: esa anulación revierte TODO el stock y el ingreso, y esta
    // devolución lo haría otra vez. Con el registro ya creado se vuelve a
    // mirar; la anulación, a su vez, cuenta las devoluciones después de su
    // flip, así que en cualquier orden al menos una de las dos se retira.
    const ahora = await this.sales.getOrFail(saleId);
    if (ahora.status === 'void') {
      await this.model.deleteOne({ _id: registro._id }).exec();
      throw new BadRequestException(
        'La venta se anuló mientras se registraba la devolución: ya se devolvió completa',
      );
    }

    // Dos devoluciones simultáneas de la misma venta leían el mismo «ya
    // devuelto» y las dos pasaban el tope: cada una reponía el stock y sacaba
    // efectivo de la caja (ítem 4.11). Con el registro ya creado se vuelve a
    // sumar TODO lo devuelto, incluido el propio; si pasa de lo vendido, este
    // se retira. En cualquier orden, a lo sumo lo vendido queda devuelto.
    const vendido = new Map<string, number>();
    for (const l of sale.lines) {
      const key = l.productId.toString();
      vendido.set(key, (vendido.get(key) ?? 0) + l.qty);
    }
    const despues = await this.alreadyReturned(sale._id);
    // La propina también: dos devoluciones a la vez la calculan sobre el mismo
    // «ya devuelto» y, entre las dos, no pueden pasar de la cobrada.
    // Y la plata: una rebaja simultánea (Fase 6C) no puede sumarse a la
    // devolución por encima de lo pagado del producto.
    const excede =
      [...despues.qty].some(([productId, qty]) => qty > (vendido.get(productId) ?? 0)) ||
      despues.tipRefund > propinaCobrada(sale) ||
      excedePagado(sale, despues.money, despues.rebated);
    if (excede) {
      await this.model.deleteOne({ _id: registro._id }).exec();
      throw new ConflictException(
        'Otra devolución de esta venta se registró al mismo tiempo. Revisa lo ya devuelto e inténtalo de nuevo.',
      );
    }

    /*
     * Fiado y nota fiscal ANTES de mover stock, caja o libro (Fase 6B). Los dos
     * pueden fallar (abono concurrente a la CxC; sin PIN, sin resolución o por
     * encima del tope de la nota) y, si fallan, la devolución se retira entera:
     * no queda devuelta en el inventario ni en la plata sin su documento.
     */
    let abonoCartera = 0;
    if (cxc && plan.refundTotal > 0) {
      try {
        abonoCartera = await this.abonarCartera(sale, registro, plan.refundTotal, user);
      } catch (err) {
        await this.model.deleteOne({ _id: registro._id }).exec();
        throw err;
      }
    }
    let nota: NotaFiscalOperacion | undefined;
    if (this.notas) {
      try {
        nota = await this.notas.emitir(sale, this.solicitudNota(registro, sale), user);
      } catch (err) {
        if (abonoCartera > 0) await this.revertirAbono(sale, registro, abonoCartera);
        await this.model.deleteOne({ _id: registro._id }).exec();
        throw err;
      }
    }
    registro.abonoCartera = abonoCartera;
    registro.aSaldoFavor = await this.parteASaldoFavor(registro, sale);
    if (nota) registro.notaFiscal = nota as unknown as Record<string, unknown>;
    registro.carteraHecha = true;
    const turno = registro.procesandoHasta ?? null;
    try {
      await registro.save();
      await this.completar(registro, sale, user, 'caja');
    } finally {
      await this.soltarTurno(registro, turno);
    }
    // La caja no espera a la DIAN: la nota se transmite detrás de la respuesta.
    this.notas?.transmitirDetras(nota, user);
    return registro;
  }

  /**
   * Rebaja o descuento POSTERIOR sobre una venta ya cobrada (Fase 6C): se le
   * reconoce al cliente un menor valor sin que vuelva mercancía.
   *
   * Es una devolución sin unidades (`kind: 'rebaja'`) y por eso comparte con
   * ella lo que ya se probó: el registro antes de mover nada, la llave
   * idempotente, el turno, la cartera del fiado, la nota que falla cerrado
   * (NC 91 o nota de ajuste 94, concepto 3–6), la salida de caja, el asiento
   * (Db 4175 + 2408/2495, Cr medio, 1305 o 2805) y el barrido de varadas. No
   * toca inventario ni costo, ni devuelve propina.
   *
   * Tope: lo pagado de cada producto menos lo devuelto y lo ya rebajado
   * (`planDeRebaja`), revisado otra vez con el registro ya creado.
   */
  async createRebaja(
    saleId: string,
    dto: CreateSaleRebateDto,
    user: JwtUser,
  ): Promise<SaleReturnDocument> {
    const sale = await this.sales.getOrFail(saleId);
    const sedeId = this.sedeIdOf(sale);
    assertSedeAccess(user, sedeId);
    if (sale.status === 'void') {
      throw new BadRequestException('La venta está anulada: no admite rebajas.');
    }
    if (sale.platform) {
      throw new BadRequestException(
        'Es un pedido de plataforma: las rebajas al cliente las maneja la plataforma.',
      );
    }
    const llave = dto.idempotencyKey.trim();
    const previa = await this.model.findOne({ saleId: sale._id, idempotencyKey: llave }).exec();
    if (previa) return this.reanudar(previa, sale, user, mismaRebaja(previa, dto));

    const fiada = hasCreditPart(sale);
    const cxc = fiada ? await this.cuentaPorCobrar(sale) : null;
    if (fiada && this.receivables && !cxc) {
      throw new ConflictException(
        'La venta se fió a un empleado (descuento por nómina): no admite rebajas. Anula la venta completa.',
      );
    }
    this.assertTerceroParaSaldo(dto.refundMethod, sale, cxc);

    const ya = await this.alreadyReturned(sale._id);
    let plan: ReturnType<typeof planDeRebaja>;
    try {
      plan = planDeRebaja(this.vendidos(sale), reconocidoPorProducto(ya), {
        total: dto.amount,
        porProducto: dto.lines,
      });
    } catch (err) {
      if (err instanceof RebajaInvalidaError) throw new BadRequestException(err.message);
      throw err;
    }
    const porNombre = new Map(sale.lines.map((l) => [l.productId.toString(), l]));

    let registro: SaleReturnDocument;
    try {
      registro = await this.model.create({
        kind: 'rebaja',
        concepto: dto.concepto,
        idempotencyKey: llave,
        saleId: sale._id,
        saleNumber: sale.saleNumber,
        sedeId: new Types.ObjectId(sedeId),
        lines: plan.lines.map((l) => {
          const vendida = porNombre.get(l.productId);
          return {
            productId: new Types.ObjectId(l.productId),
            sku: vendida?.sku ?? '',
            name: vendida?.name ?? '',
            qty: 0,
            refund: l.amount,
            refundTax: l.tax,
          };
        }),
        components: [],
        wasteRecorded: false,
        estado: 'en_curso',
        procesandoHasta: new Date(Date.now() + SaleReturnsService.TURNO_MS),
        carteraHecha: false,
        // No vuelve mercancía: el paso de stock nace hecho.
        stockHecho: true,
        cajaHecha: false,
        asientoHecho: false,
        refundMethod: dto.refundMethod,
        refundTotal: plan.amount,
        refundTax: plan.tax,
        tipRefund: 0,
        note: dto.reason.trim(),
        userId: user.userId,
        userEmail: user.email,
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        const ganadora = await this.model.findOne({ saleId: sale._id, idempotencyKey: llave }).exec();
        if (ganadora) return this.reanudar(ganadora, sale, user, mismaRebaja(ganadora, dto));
      }
      throw err;
    }

    // Anulación, devolución u otra rebaja simultáneas: con el registro ya
    // creado se vuelve a sumar todo; si pasa de lo pagado, esta se retira.
    const ahora = await this.sales.getOrFail(saleId);
    const despues = await this.alreadyReturned(sale._id);
    if (ahora.status === 'void' || excedePagado(sale, despues.money, despues.rebated)) {
      await this.model.deleteOne({ _id: registro._id }).exec();
      throw new ConflictException(
        ahora.status === 'void'
          ? 'La venta se anuló mientras se registraba la rebaja.'
          : 'Otra devolución o rebaja de esta venta se registró al mismo tiempo. Revisa lo ya reconocido e inténtalo de nuevo.',
      );
    }

    // Cartera y nota ANTES de caja y libro, como en la devolución.
    let abonoCartera = 0;
    if (cxc && plan.amount > 0) {
      try {
        abonoCartera = await this.abonarCartera(sale, registro, plan.amount, user);
      } catch (err) {
        await this.model.deleteOne({ _id: registro._id }).exec();
        throw err;
      }
    }
    let nota: NotaFiscalOperacion | undefined;
    if (this.notas) {
      try {
        nota = await this.notas.emitir(sale, this.solicitudNota(registro, sale), user);
      } catch (err) {
        if (abonoCartera > 0) await this.revertirAbono(sale, registro, abonoCartera);
        await this.model.deleteOne({ _id: registro._id }).exec();
        throw err;
      }
    }
    registro.abonoCartera = abonoCartera;
    registro.aSaldoFavor = await this.parteASaldoFavor(registro, sale);
    if (nota) registro.notaFiscal = nota as unknown as Record<string, unknown>;
    registro.carteraHecha = true;
    const turno = registro.procesandoHasta ?? null;
    try {
      await registro.save();
      await this.completar(registro, sale, user, 'caja');
    } finally {
      await this.soltarTurno(registro, turno);
    }
    this.notas?.transmitirDetras(nota, user);
    return registro;
  }

  /** Lo vendido por producto (lo que pagó el cliente, neto del descuento). */
  private vendidos(sale: SaleDocument): ProductoVendido[] {
    return sale.lines.map((l) => ({
      productId: l.productId.toString(),
      qty: l.qty,
      taxBase: l.taxBase,
      taxAmount: l.taxAmount,
    }));
  }

  /**
   * Toma el turno de una devolución `en_curso` (N1): un `findOneAndUpdate`
   * condicionado a que nadie lo tenga o a que el anterior ya venció. Devuelve
   * el registro FRESCO (con las marcas que haya dejado otra petición) o
   * `null` si otro lo tiene.
   */
  private async tomarTurno(id: Types.ObjectId): Promise<SaleReturnDocument | null> {
    const ahora = new Date();
    return this.model
      .findOneAndUpdate(
        {
          _id: id,
          estado: { $in: ESTADOS_ABIERTOS },
          $or: [{ procesandoHasta: null }, { procesandoHasta: { $lt: ahora } }],
        },
        { $set: { procesandoHasta: new Date(ahora.getTime() + SaleReturnsService.TURNO_MS) } },
        { new: true },
      )
      .exec();
  }

  /**
   * Suelta el turno al terminar o al fallar, solo si sigue siendo el PROPIO
   * (N5): si el de esta petición venció y otra lo tomó, soltarlo a ciegas le
   * quitaría el turno a la otra. Si falla, el turno vence solo.
   */
  private async soltarTurno(registro: SaleReturnDocument, turno: Date | null): Promise<void> {
    if (!turno) return;
    try {
      await this.model
        .updateOne({ _id: registro._id, procesandoHasta: turno }, { $set: { procesandoHasta: null } })
        .exec();
    } catch (err) {
      this.logger.warn(
        `No se pudo soltar el turno de la devolución ${registro._id.toString()} (vence solo): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Completa a mano una devolución que quedó `en_curso` o `pendiente_caja`
   * (N2, N6): la que no trae llave no tiene cómo reintentarse desde la caja, y
   * sus cantidades ya cuentan como devueltas. Es el ÚNICO camino que anota la
   * salida de efectivo de una devolución varada: lo hace el cajero con su
   * caja abierta, y sin caja abierta responde 409. Una completa se devuelve
   * tal cual.
   */
  async completarPendiente(returnId: string, user: JwtUser): Promise<SaleReturnDocument> {
    const registro = Types.ObjectId.isValid(returnId)
      ? await this.model.findById(returnId).exec()
      : null;
    if (!registro) throw new NotFoundException('Devolución no encontrada');
    assertSedeAccess(user, registro.sedeId.toString());
    if (!estaAbierta(registro)) return registro;
    const sale = await this.sales.getOrFail(registro.saleId.toString());
    return this.continuar(registro, sale, user, 'caja_estricta');
  }

  /**
   * Barrido de la empresa activa (N2): completa las devoluciones `en_curso`
   * con más de `VARADA_MS`, respetando el turno de quien las esté
   * procesando. Lo llama el cron diario dentro del contexto de cada empresa.
   * Nunca lanza por una devolución: la que falla queda para el día siguiente.
   */
  async completarVaradas(
    opts: { limite?: number; ahora?: Date } = {},
  ): Promise<{ completadas: number; pendientesCaja: number; fallidas: number; ocupadas: number }> {
    const ahora = opts.ahora ?? new Date();
    const varadas = await this.model
      .find({
        estado: 'en_curso',
        createdAt: { $lt: new Date(ahora.getTime() - SaleReturnsService.VARADA_MS) },
        $or: [{ procesandoHasta: null }, { procesandoHasta: { $lt: ahora } }],
      })
      .sort({ createdAt: 1 })
      .limit(opts.limite ?? 50)
      .exec();
    let completadas = 0;
    let pendientesCaja = 0;
    let fallidas = 0;
    let ocupadas = 0;
    for (const r of varadas) {
      try {
        const sale = await this.sales.getOrFail(r.saleId.toString());
        // Sin caja (N6): la caja abierta HOY no es la del turno de la
        // devolución; anotar ahí la salida descuadraría su arqueo. Stock y
        // libro sí; la caja queda `pendiente_caja` para el endpoint manual.
        const hecha = await this.continuar(r, sale, usuarioDelRegistro(r), 'sin_caja');
        if (hecha.estado === 'completa') completadas++;
        else if (hecha.estado === 'pendiente_caja') pendientesCaja++;
        else fallidas++;
      } catch (err) {
        if (err instanceof ConflictException) {
          ocupadas++;
          continue;
        }
        fallidas++;
        this.logger.error(
          `CONCILIAR: la devolución ${r._id.toString()} de la venta ${r.saleNumber} sigue en curso: ${(err as Error).message}`,
        );
      }
    }
    return { completadas, pendientesCaja, fallidas, ocupadas };
  }

  /**
   * Stock, caja y libro de una devolución ya registrada, con su nota (D1).
   *
   * Cada paso deja su marca en el registro apenas termina, así un fallo a
   * mitad deja la devolución `en_curso` con lo que falta a la vista, y el
   * reintento con la misma llave (`reanudar`) retoma desde ahí sin repetir lo
   * hecho. El orden es el de siempre: stock, caja, libro.
   *
   * - Stock: si falla, lanza y no se sigue (no se devuelve plata por
   *   mercancía que no volvió al inventario).
   * - Caja: si falla (no hay caja abierta), se registra y se sigue con el
   *   libro, como antes; la devolución queda `en_curso` hasta que un
   *   reintento la anote.
   * - Libro: idempotente por origen (`sale_return` + id de la devolución).
   *
   * Queda una ventana que no se puede cerrar sin idempotencia en el stock y la
   * caja: caerse ENTRE el movimiento y su marca lo repetiría en el reintento.
   */
  private async completar(
    registro: SaleReturnDocument,
    sale: SaleDocument,
    user: JwtUser,
    caja: ModoCaja,
  ): Promise<void> {
    const sedeId = registro.sedeId.toString();

    if (!registro.stockHecho) {
      const units = this.unidadesDelRegistro(registro, sale);
      // La mercancía vuelve al inventario, a los mismos lotes de los que salió.
      // También cuando se va a merma: primero entra y después se da de baja,
      // para que el kárdex cuente la historia completa —volvió, y se dañó— en
      // vez de que la unidad desaparezca sin explicación.
      if (units.length > 0) await this.stock.reverseSale(sedeId, units, user);
      registro.stockHecho = true;
      await registro.save();

      if (registro.restock === 'waste' && units.length > 0) {
        /*
         * La baja va en un segundo paso y puede fallar sola. Si falla, queda
         * existencia de MÁS —visible, y se corrige con un ajuste—, que es
         * preferible a lo contrario: descontar sin haber devuelto dejaría el
         * inventario corto sin que nadie se entere.
         */
        let todas = true;
        for (const u of units) {
          try {
            await this.stock.adjust(
              {
                productId: u.productId,
                sedeId,
                direction: 'remove',
                qty: u.qty,
                reason: 'dano',
                note: `Devolución de la venta ${sale.saleNumber}`,
              } as never,
              user,
            );
          } catch (err) {
            todas = false;
            this.logger.warn(
              `No se pudo dar de baja lo devuelto de ${u.productId} en la venta ${sale.saleNumber}: ${(err as Error).message}`,
            );
          }
        }
        registro.wasteRecorded = todas;
        await registro.save();
      }
    }

    if (!registro.cajaHecha) {
      // La plata que sale de la caja del turno. Solo el efectivo: una
      // transferencia o una nota a favor no vacían el cajón, y anotarlas ahí
      // haría que el arqueo del cierre no cuadrara.
      // Lo que bajó la cartera de un fiado no sale de ninguna parte: el cliente
      // simplemente debe menos. Solo el resto se devuelve por el medio elegido,
      // con la propina devuelta (decisión 4), que entró al cajón con el cobro.
      // Lo pagado con saldo a favor (Fase 6C) vuelve al saldo, nunca al cajón.
      const enPlata = clampNonNegative(
        registro.refundTotal - (registro.abonoCartera ?? 0) + (registro.tipRefund ?? 0) - (registro.aSaldoFavor ?? 0),
      );
      let hecha = true;
      if (registro.refundMethod === 'cash' && enPlata > 0 && caja === 'sin_caja') {
        // El barrido no toca la caja (N6): queda para el cajero.
        hecha = false;
      } else if (registro.refundMethod === 'cash' && enPlata > 0) {
        try {
          await this.caja.movement(
            {
              sedeId,
              type: 'out',
              amount: enPlata,
              reason: registro.kind === 'rebaja' ? 'Rebaja de venta' : 'Devolución de venta',
              note: `Venta ${sale.saleNumber}`,
            } as never,
            user,
          );
        } catch (err) {
          if (caja === 'caja_estricta') {
            if (err instanceof NotFoundException) {
              throw new ConflictException(
                'No hay una caja abierta en la sede: ábrela para registrar la salida del efectivo de esta devolución.',
              );
            }
            throw err;
          }
          hecha = false;
          this.logger.warn(
            `No se pudo registrar en caja la devolución de la venta ${sale.saleNumber}: ${(err as Error).message}`,
          );
        }
      }
      if (hecha) {
        registro.cajaHecha = true;
        await registro.save();
      }
    }

    if (!registro.asientoHecho) {
      // N3: `postSaleReturn` no lanza si el posteo falla: `safePost` lo
      // registra para conciliación y devuelve. La marca queda igual, con el
      // mismo criterio que el resto de asientos automáticos; un reintento no
      // lo arreglaría (el origen es el mismo) y sí dejaría la devolución
      // varada para siempre.
      // El saldo a favor del cliente (Fase 6C) va con el asiento que acredita
      // la 2805, y antes que él: es idempotente por devolución, así que un
      // reintento no abona dos veces.
      await this.abonarSaldoFavor(registro, sale);
      await this.postToLedger(registro, sale);
      registro.asientoHecho = true;
      await registro.save();
    }

    if (registro.stockHecho && registro.cajaHecha && registro.asientoHecho) {
      registro.estado = 'completa';
      await registro.save();
    } else if (registro.stockHecho && registro.asientoHecho && registro.estado !== 'pendiente_caja') {
      // Solo falta la salida de efectivo (N6): queda a la vista y fuera del
      // barrido, que no la puede anotar. La completa el cajero a mano.
      registro.estado = 'pendiente_caja';
      await registro.save();
    }
  }

  /**
   * Lo que vuelve al inventario, armado desde el registro: los ítems y
   * cantidades que la devolución fijó al crearse, con sus lotes repartidos
   * igual que en `unitsToReturn`. Así el reintento mueve exactamente lo mismo.
   */
  private unidadesDelRegistro(registro: SaleReturnDocument, sale: SaleDocument) {
    return (registro.components ?? [])
      .filter((c) => c.qty > 0)
      .map((c) => {
        const productId = c.productId.toString();
        const componente = sale.components.find((x) => x.productId.toString() === productId);
        return {
          productId,
          qty: c.qty,
          consumedLots: componente
            ? prorateLots(
                (componente.consumedLots ?? []).map((cl) => ({
                  lotId: cl.lotId?.toString(),
                  qty: cl.qty,
                  unitCost: cl.unitCost,
                })),
                componente.qty,
                c.qty,
              )
            : [],
        };
      });
  }

  /** Lo que la nota de la devolución acredita: los mismos valores que van al libro. */
  /** Pública para la transcripción de contingencia (Fase 9), que emite las notas que faltaron. */
  solicitudNota(registro: SaleReturnDocument, sale: SaleDocument): Omit<SolicitudNotaVenta, 'saleId'> {
    if (registro.kind === 'rebaja') {
      // Rebaja (Fase 6C): sin unidades; la nota acredita el valor por producto.
      return {
        origen: origenNotaRebaja(registro._id.toString()),
        concepto: registro.concepto ?? '3',
        motivo: `Rebaja sobre la venta ${sale.saleNumber}: ${registro.note ?? ''}`.trim(),
        lineas: registro.lines.map((l) => ({
          productId: l.productId.toString(),
          qty: 0,
          valor: l.refund,
          impuesto: l.refundTax ?? 0,
        })),
      };
    }
    const motivo = [
      `Devolución de la venta ${sale.saleNumber} (${MOTIVO_DEVOLUCION[registro.reason] ?? registro.reason})`,
      registro.note,
    ]
      .filter(Boolean)
      .join(': ');
    return {
      origen: origenNotaDevolucion(registro._id.toString()),
      concepto: '1' as const,
      motivo,
      // La propina viaja en el documento como cargo (AllowanceCharge): la nota
      // acredita la parte devuelta (decisión 4).
      propina: registro.tipRefund ?? 0,
      lineas: registro.lines.map((l) => ({
        productId: l.productId.toString(),
        qty: l.qty,
        valor: l.refund,
        impuesto: l.refundTax ?? 0,
      })),
    };
  }

  /**
   * Reintento de una devolución ya registrada con la misma llave.
   *
   * - Si la carga es otra (líneas, cantidades, medio, destino o motivo), 409:
   *   la llave es de OTRA devolución y devolver la vieja en silencio haría
   *   creer al cajero que se registró lo que pidió (D2).
   * - Si quedó a medias (`en_curso`), completa lo que falte en el mismo orden
   *   que `create`: cartera, nota, stock, caja y libro (D1).
   * - Si ya estaba completa (o es de antes de los pasos), no mueve nada: solo
   *   emite la nota si no alcanzó a quedar (idempotente por devolución).
   */
  private async reanudar(
    registro: SaleReturnDocument,
    sale: SaleDocument,
    user: JwtUser,
    misma: boolean,
  ): Promise<SaleReturnDocument> {
    if (!misma) {
      throw new ConflictException(
        registro.kind === 'rebaja'
          ? 'Esa llave ya se usó para otra operación de esta venta, con otro concepto, monto o medio. Revisa lo ya reconocido y usa una llave nueva.'
          : 'Esa llave ya se usó para otra devolución de esta venta, con otros productos, cantidades o medio de devolución. Revisa lo ya devuelto y usa una llave nueva.',
      );
    }
    if (estaAbierta(registro)) return this.continuar(registro, sale, user, 'caja');
    // Completa (o de antes de los pasos): no se mueve nada; solo la nota, si
    // no alcanzó a quedar (idempotente por devolución).
    if (this.notas && !registro.notaFiscal) {
      const nota = await this.notas.emitir(sale, this.solicitudNota(registro, sale), user);
      registro.notaFiscal = nota as unknown as Record<string, unknown>;
      await registro.save();
      this.notas.transmitirDetras(nota, user);
    }
    return registro;
  }

  /**
   * Termina una devolución `en_curso` con el turno tomado (N1), en el mismo
   * orden que `create`: cartera, nota, stock, caja y libro. Sin turno, 409:
   * otra petición la está completando.
   */
  private async continuar(
    previo: SaleReturnDocument,
    sale: SaleDocument,
    user: JwtUser,
    caja: ModoCaja,
  ): Promise<SaleReturnDocument> {
    const registro = await this.tomarTurno(previo._id);
    if (!registro) {
      const ahora = await this.model.findById(previo._id).exec();
      if (ahora && !estaAbierta(ahora)) return ahora;
      throw new ConflictException('La devolución se está procesando; reintenta en unos segundos.');
    }
    const turno = registro.procesandoHasta ?? null;
    let nota: NotaFiscalOperacion | undefined;
    try {
      if (!registro.carteraHecha) {
        const cxc = hasCreditPart(sale) ? await this.cuentaPorCobrar(sale) : null;
        if (cxc && registro.refundTotal > 0) {
          registro.abonoCartera = await this.abonarCartera(sale, registro, registro.refundTotal, user);
        }
        registro.aSaldoFavor = await this.parteASaldoFavor(registro, sale);
        registro.carteraHecha = true;
        await registro.save();
      }
      if (this.notas && !registro.notaFiscal) {
        nota = await this.notas.emitir(sale, this.solicitudNota(registro, sale), user);
        registro.notaFiscal = nota as unknown as Record<string, unknown>;
        await registro.save();
      }
      await this.completar(registro, sale, user, caja);
    } finally {
      await this.soltarTurno(registro, turno);
    }
    if (nota) this.notas?.transmitirDetras(nota, user);
    return registro;
  }

  /**
   * Cliente de la devolución (Fase 6D). Regla: la nota crédito va al
   * adquiriente de la factura original, así que si la venta ya tiene cliente
   * (el de la venta o el deudor del fiado) el indicado tiene que ser ese mismo;
   * otro distinto se RECHAZA. Solo cuando la venta no tiene cliente se acepta
   * el indicado, y debe existir en la empresa (404 si no es de este tenant).
   * Devuelve el cliente efectivo o undefined.
   */
  private async resolverCliente(
    indicado: string | undefined,
    sale: SaleDocument,
    cxc: FinanceReceivableDocument | null,
  ): Promise<string | undefined> {
    const deLaVenta = sale.customerId?.toString() ?? cxc?.customerId?.toString();
    if (!indicado) return deLaVenta;
    if (deLaVenta) {
      if (deLaVenta !== indicado) {
        throw new BadRequestException(
          'La venta ya tiene otro cliente: la nota crédito se emite al cliente de la factura original. Quita el cliente de la devolución o usa el de la venta.',
        );
      }
      return deLaVenta;
    }
    if (!this.customers) {
      throw new BadRequestException('No se puede validar el cliente de la devolución.');
    }
    const cliente = await this.customers.getOrFail(indicado);
    return cliente._id.toString();
  }

  /**
   * Sin tercero no hay a quién dejarle saldo a favor (revisión 6C): la 2805
   * quedaría con un saldo que nadie puede gastar.
   */
  private assertTerceroParaSaldo(
    refundMethod: string,
    sale: SaleDocument,
    cxc: FinanceReceivableDocument | null,
    clienteId?: string,
  ): void {
    if (refundMethod !== 'credit_note' && refundMethod !== 'none') return;
    if (sale.customerId || cxc?.customerId || clienteId) return;
    throw new BadRequestException(
      'La venta no tiene cliente registrado: identifica al cliente o devuelve en efectivo/transferencia.',
    );
  }

  /**
   * Cuánto de lo que se reconoce ahora vuelve al saldo a favor porque se pagó
   * con él (Fase 6C): después del abono a la CxC, hasta lo pagado con
   * `saldo_favor` menos lo que ya volvió en devoluciones y rebajas previas.
   */
  private async parteASaldoFavor(registro: SaleReturnDocument, sale: SaleDocument): Promise<number> {
    const pagado = sumBy(
      salePartsOf(sale).filter((p) => p.method === 'saldo_favor'),
      (p) => p.amount,
    );
    if (pagado <= 0) return 0;
    const previas = await this.model.find({ saleId: sale._id }).exec();
    const yaVolvio = sumBy(
      previas.filter((p) => String(p._id) !== String(registro._id)),
      (p) => p.aSaldoFavor ?? 0,
    );
    const reconocido = clampNonNegative(
      registro.refundTotal - (registro.abonoCartera ?? 0) + (registro.tipRefund ?? 0),
    );
    return Math.min(reconocido, clampNonNegative(pagado - yaVolvio));
  }

  /**
   * Lo que el asiento acredita a la 2805 (devolución o rebaja `credit_note`,
   * o cambio `none`: lo devuelto menos lo que bajó la cartera, más la
   * propina), abonado al tercero de la venta. Sin tercero queda en el auxiliar
   * sin cliente: se ve en el reporte, pero nadie lo puede gastar.
   */
  private async abonarSaldoFavor(registro: SaleReturnDocument, sale: SaleDocument): Promise<void> {
    if (!this.saldoFavor) return;
    const aSaldo = registro.aSaldoFavor ?? 0;
    const resto = clampNonNegative(
      registro.refundTotal - (registro.abonoCartera ?? 0) + (registro.tipRefund ?? 0) - aSaldo,
    );
    // Lo pagado con saldo a favor vuelve siempre al saldo; el resto, solo si el medio es a favor.
    const amount = aSaldo + (registro.refundMethod === 'credit_note' || registro.refundMethod === 'none' ? resto : 0);
    if (amount <= 0) return;
    const deCxc =
      sale.customerId || registro.customerId ? null : await this.cuentaPorCobrar(sale).catch(() => null);
    const clienteIndicado =
      !sale.customer?.name && registro.customerId && this.customers
        ? await this.customers.getOrFail(registro.customerId.toString()).catch(() => null)
        : null;
    await this.saldoFavor.abonar({
      customerId: registro.customerId ?? sale.customerId ?? deCxc?.customerId ?? null,
      customerName: sale.customer?.name ?? clienteIndicado?.name,
      amount,
      sourceType: 'sale_return',
      sourceId: registro._id.toString(),
      sedeId: registro.sedeId.toString(),
      memo: `${registro.kind === 'rebaja' ? 'Rebaja' : 'Devolución'} de la venta ${sale.saleNumber}`,
    });
  }

  /** CxC del fiado a cliente (la del empleado no deja CxC). */
  private async cuentaPorCobrar(sale: SaleDocument): Promise<FinanceReceivableDocument | null> {
    if (!this.receivables) return null;
    return this.receivables.findOne({ saleId: sale._id, status: { $ne: 'void' } }).exec();
  }

  /**
   * Baja la cuenta por cobrar de la venta fiada por lo devuelto, hasta su
   * saldo (lo que el cliente todavía debe). Update atómico condicionado a lo
   * leído, como el abono de `FinanceService`: un abono que entre a la vez no
   * se pisa. Devuelve lo que bajó; el resto, si el cliente ya había pagado,
   * se le devuelve por el medio elegido.
   */
  private async abonarCartera(
    sale: SaleDocument,
    registro: SaleReturnDocument,
    monto: number,
    user: JwtUser,
  ): Promise<number> {
    for (let intento = 0; intento < 3; intento++) {
      const cxc = await this.cuentaPorCobrar(sale);
      if (!cxc) return 0;
      // Un reintento (D1) no abona dos veces: si esta devolución ya bajó la
      // cartera, se devuelve lo que bajó.
      const previo = (cxc.ajustes ?? []).find((a) => a.returnId === registro._id.toString());
      if (previo) return previo.amount;
      const abono = Math.min(cop(monto), clampNonNegative(cxc.amount - cxc.paidAmount));
      if (abono <= 0) return 0;
      const nuevo = cxc.amount - abono;
      const status = cxc.paidAmount >= nuevo ? 'paid' : cxc.paidAmount > 0 ? 'partial' : 'open';
      const hecho = await this.receivables!
        .findOneAndUpdate(
          { _id: cxc._id, amount: cxc.amount, paidAmount: cxc.paidAmount, status: { $ne: 'void' } },
          {
            $inc: { amount: -abono },
            $push: {
              ajustes: {
                date: fechaColombia(),
                amount: abono,
                returnId: registro._id.toString(),
                motivo: `Devolución de la venta ${sale.saleNumber}`,
                userEmail: user.email,
              },
            },
            $set: { status },
          },
          { new: true },
        )
        .exec();
      if (hecho) return abono;
    }
    throw new ConflictException(
      'La cuenta por cobrar de la venta cambió mientras se registraba la devolución. Vuelve a intentarlo.',
    );
  }

  /** Deshace `abonarCartera` cuando la devolución se retira (la nota no se pudo emitir). */
  private async revertirAbono(
    sale: SaleDocument,
    registro: SaleReturnDocument,
    abono: number,
  ): Promise<void> {
    const returnId = registro._id.toString();
    try {
      const cxc = await this.receivables!
        .findOneAndUpdate(
          { saleId: sale._id, 'ajustes.returnId': returnId },
          { $inc: { amount: abono }, $pull: { ajustes: { returnId } } },
          { new: true },
        )
        .exec();
      if (cxc) {
        const status = cxc.paidAmount >= cxc.amount ? 'paid' : cxc.paidAmount > 0 ? 'partial' : 'open';
        await this.receivables!.updateOne({ _id: cxc._id }, { $set: { status } }).exec();
      }
    } catch (err) {
      this.logger.error(
        `CONCILIAR: la devolución ${returnId} de la venta ${sale.saleNumber} se retiró pero la cartera no volvió a su valor (${abono}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Asiento de la devolución: el espejo de la venta, pero solo por lo que
   * volvió.
   *
   * No se puede reversar el asiento de la venta —esa venta sí ocurrió, y
   * reversarla entera borraría del libro lo que el cliente sí se quedó—, así
   * que se postea un asiento propio por el monto devuelto.
   */
  private async postToLedger(
    registro: SaleReturnDocument,
    sale: SaleDocument,
  ): Promise<void> {
    // El costo ya repartido por ítem al armar el registro (0 si fue merma).
    const cogs = sumBy(registro.components ?? [], (c) => c.cogs);

    // El impuesto devuelto se reversa contra la cuenta en que se causó: el INC
    // de una venta de restaurante vuelve a la 2495, no a la 2408. Las líneas
    // anteriores a `taxKind` eran IVA.
    const kindOf = new Map(
      sale.lines.map((l) => [l.productId.toString(), l.taxKind ?? 'iva']),
    );
    // Cada impuesto se suma por su tipo con `sumBy`, como en la venta (taxOf):
    // `refundTax − incDevuelto` redondeaba dos veces y podía mandar un peso de
    // INC a la cuenta del IVA.
    const taxOf = (kind: SaleTaxKind) =>
      sumBy(
        registro.lines.filter((l) => kindOf.get(l.productId.toString()) === kind),
        (l) => l.refundTax,
      );
    const incDevuelto = taxOf('inc');
    const ivaDevuelto = taxOf('iva');

    await this.ledgerPosting.postSaleReturn({
      returnId: registro._id.toString(),
      saleNumber: sale.saleNumber,
      date: fechaColombia(),
      sedeId: registro.sedeId.toString(),
      refundTotal: registro.refundTotal,
      tax: ivaDevuelto,
      consumptionTax: incDevuelto,
      cogs,
      // Una nota a favor o un cambio por otro producto no sacan plata hoy: la
      // contrapartida es lo que el negocio le queda debiendo al cliente.
      refundMethod: registro.refundMethod,
      // Lo que bajó la cartera del fiado va contra la 1305, no por el medio elegido.
      toReceivable: registro.abonoCartera ?? 0,
      // Lo pagado con saldo a favor vuelve a la 2805 (Fase 6C).
      toCustomerCredit: registro.aSaldoFavor ?? 0,
      // La propina devuelta sale de la 2380 (decisión 4).
      tip: registro.tipRefund ?? 0,
      memo: registro.kind === 'rebaja' ? `Rebaja posterior de la venta ${sale.saleNumber}` : undefined,
      userEmail: registro.userEmail,
    });
  }
}

/**
 * ¿El reintento trae la misma devolución que quedó registrada? Se comparan
 * las cantidades por producto (agrupadas, como las agrupa el plan), el medio,
 * el destino de la mercancía y el motivo.
 */
function mismaCarga(registro: SaleReturnDocument, dto: CreateSaleReturnDto): boolean {
  const huella = (ls: readonly { productId: unknown; qty: number }[]) => {
    const m = new Map<string, number>();
    for (const l of ls) m.set(String(l.productId), (m.get(String(l.productId)) ?? 0) + l.qty);
    return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, q]) => `${k}:${q}`).join('|');
  };
  return (
    registro.kind !== 'rebaja' &&
    registro.refundMethod === dto.refundMethod &&
    registro.restock === dto.restock &&
    registro.reason === dto.reason &&
    (!dto.customerId || registro.customerId?.toString() === dto.customerId) &&
    huella(registro.lines) === huella(dto.lines ?? [])
  );
}

/**
 * Usuario con el que el barrido completa una devolución varada (N2): quien la
 * registró, con acceso solo a la sede de la devolución. No lleva permisos: lo
 * que falta (stock, caja, libro) no los pide.
 */
function usuarioDelRegistro(r: SaleReturnDocument): JwtUser {
  return {
    userId: r.userId,
    email: r.userEmail,
    name: r.userEmail,
    role: 'system',
    sedeIds: [r.sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;
}

/**
 * Qué hace `completar` con la salida de efectivo (N6):
 * - `caja`: la anota y, si falla, sigue (la devolución queda `pendiente_caja`).
 * - `caja_estricta`: el cajero a mano; sin caja abierta, 409.
 * - `sin_caja`: el barrido; no la toca.
 */
type ModoCaja = 'caja' | 'caja_estricta' | 'sin_caja';

/** Estados en los que la devolución todavía tiene pasos por hacer. */
const ESTADOS_ABIERTOS: ('en_curso' | 'pendiente_caja')[] = ['en_curso', 'pendiente_caja'];

const estaAbierta = (r: { estado?: string }) =>
  (ESTADOS_ABIERTOS as string[]).includes(r.estado ?? '');

/**
 * ¿El reintento trae la misma rebaja? Concepto, medio y lo rebajado: el total
 * si se pidió así, o el monto por producto.
 */
function mismaRebaja(registro: SaleReturnDocument, dto: CreateSaleRebateDto): boolean {
  if (registro.kind !== 'rebaja') return false;
  if (registro.concepto !== dto.concepto || registro.refundMethod !== dto.refundMethod) return false;
  if (dto.amount !== undefined) return !dto.lines?.length && cop(dto.amount) === registro.refundTotal;
  const huella = (ls: readonly { productId: unknown; amount: number }[]) => {
    const m = new Map<string, number>();
    for (const l of ls) m.set(String(l.productId), (m.get(String(l.productId)) ?? 0) + cop(l.amount));
    return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, q]) => `${k}:${q}`).join('|');
  };
  return huella(registro.lines.map((l) => ({ productId: l.productId, amount: l.refund }))) === huella(dto.lines ?? []);
}

/** Lo devuelto y lo rebajado por producto, en la forma de `planDeRebaja`. */
function reconocidoPorProducto(ya: {
  money: ReadonlyMap<string, { refund: number; refundTax: number }>;
  rebated: ReadonlyMap<string, { amount: number; tax: number }>;
}): Map<string, YaReconocido> {
  const out = new Map<string, YaReconocido>();
  for (const k of new Set([...ya.money.keys(), ...ya.rebated.keys()])) {
    const m = ya.money.get(k);
    const r = ya.rebated.get(k);
    out.set(k, {
      refund: m?.refund ?? 0,
      refundTax: m?.refundTax ?? 0,
      rebated: r?.amount ?? 0,
      rebatedTax: r?.tax ?? 0,
    });
  }
  return out;
}

/**
 * ¿Lo devuelto más lo rebajado de algún producto pasa de lo que se pagó por
 * él? Es la revisión de carrera entre devoluciones y rebajas simultáneas.
 */
function excedePagado(
  sale: SaleDocument,
  money: ReadonlyMap<string, { refund: number; refundTax: number }>,
  rebated: ReadonlyMap<string, { amount: number; tax: number }>,
): boolean {
  const pagado = new Map<string, number>();
  for (const l of sale.lines) {
    const k = l.productId.toString();
    pagado.set(k, (pagado.get(k) ?? 0) + cop(l.taxBase + l.taxAmount));
  }
  return [...pagado].some(
    ([k, p]) => (money.get(k)?.refund ?? 0) + (rebated.get(k)?.amount ?? 0) > p,
  );
}
