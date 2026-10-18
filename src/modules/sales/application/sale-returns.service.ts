import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SaleReturn,
  SaleReturnDocument,
} from '../infrastructure/schemas/sale-return.schema';
import { SaleDocument } from '../infrastructure/schemas/sale.schema';
import { CreateSaleReturnDto } from './dto/create-sale-return.dto';
import { SalesService } from './sales.service';
import { StockService } from '../../inventory/application/stock.service';
import { CatalogService } from '../../catalog/application/catalog.service';
import { CajaService } from '../../caja/application/caja.service';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import {
  buildReturnPlan,
  cogsForReturn,
  prorateLots,
  ReturnPlan,
} from '../domain/sale-return';
import { sumBy } from '../../finance/domain/money.util';
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
  }> {
    const previas = await this.model.find({ saleId }).exec();
    const qty = new Map<string, number>();
    // La plata ya devuelta por línea: la última devolución salda exacto lo
    // que falte de lo pagado (ítem 1.11), sin pesos colgando.
    const money = new Map<string, { refund: number; refundTax: number }>();
    const components = new Map<string, number>();
    for (const p of previas) {
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
    return { qty, money, components };
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
      );
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Devolución inválida',
      );
    }

    const units = await this.unitsToReturn(sale, plan, yaDevuelto.components);

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
    const registro = await this.model.create({
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
      refundMethod: dto.refundMethod,
      refundTotal: plan.refundTotal,
      refundTax: plan.refundTax,
      note: dto.note?.trim() || undefined,
      userId: user.userId,
      userEmail: user.email,
    });

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
    const excede = [...despues.qty].some(
      ([productId, qty]) => qty > (vendido.get(productId) ?? 0),
    );
    if (excede) {
      await this.model.deleteOne({ _id: registro._id }).exec();
      throw new ConflictException(
        'Otra devolución de esta venta se registró al mismo tiempo. Revisa lo ya devuelto e inténtalo de nuevo.',
      );
    }

    // La mercancía vuelve al inventario, a los mismos lotes de los que salió.
    // También cuando se va a merma: primero entra y después se da de baja, para
    // que el kárdex cuente la historia completa —volvió, y se dañó— en vez de
    // que la unidad desaparezca sin explicación.
    if (units.length > 0) {
      await this.stock.reverseSale(sedeId, units, user);
    }

    if (dto.restock === 'waste' && units.length > 0) {
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

    // La plata que sale de la caja del turno. Solo el efectivo: una
    // transferencia o una nota a favor no vacían el cajón, y anotarlas ahí
    // haría que el arqueo del cierre no cuadrara.
    if (dto.refundMethod === 'cash' && plan.refundTotal > 0) {
      try {
        await this.caja.movement(
          {
            sedeId,
            type: 'out',
            amount: plan.refundTotal,
            reason: 'Devolución de venta',
            note: `Venta ${sale.saleNumber}`,
          } as never,
          user,
        );
      } catch (err) {
        this.logger.warn(
          `No se pudo registrar en caja la devolución de la venta ${sale.saleNumber}: ${(err as Error).message}`,
        );
      }
    }

    await this.postToLedger(registro, sale, dto);
    return registro;
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
    dto: CreateSaleReturnDto,
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
      refundMethod: dto.refundMethod,
      userEmail: registro.userEmail,
    });
  }
}
