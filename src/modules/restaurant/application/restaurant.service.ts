import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  RestaurantTable,
  RestaurantTableDocument,
} from '../infrastructure/schemas/restaurant-table.schema';
import {
  RestaurantOrder,
  RestaurantOrderDocument,
} from '../infrastructure/schemas/restaurant-order.schema';
import {
  Counter,
  CounterDocument,
} from '../../sales/infrastructure/schemas/counter.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';
import {
  DEFAULT_INC_RATE,
  DEFAULT_TIP_RATE,
} from '../domain/restaurant.constants';
import { ParamsService } from '../../core-params/application/params.service';
import { TaxService } from '../../core-tax/application/tax.service';
import {
  AddItemsDto,
  CancelOrderDto,
  CreateTableDto,
  OpenOrderDto,
  SetTipDto,
  UpdateTableDto,
} from './dto/restaurant.dto';

/** Ítem de comanda con su _id de subdocumento (schema con _id:true). */
type OrderItemWithId = RestaurantOrderDocument['items'][number] & {
  _id: Types.ObjectId;
  sentToKitchen: boolean;
};

@Injectable()
export class RestaurantService {
  private readonly logger = new Logger(RestaurantService.name);

  constructor(
    @InjectModel(RestaurantTable.name)
    private readonly tables: Model<RestaurantTableDocument>,
    @InjectModel(RestaurantOrder.name)
    private readonly orders: Model<RestaurantOrderDocument>,
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
    private readonly params: ParamsService,
    private readonly tax: TaxService,
  ) {}

  /**
   * Resuelve las tarifas de INC y propina desde los motores centrales
   * (core-tax `INC_8` y core-params `propina.sugerida`). Si por cualquier razón
   * no se pueden resolver (aún no sembradas, error de BD, etc.) cae a los
   * defaults del módulo para NO romper el flujo de apertura de comanda.
   */
  private async resolveRates(): Promise<{ incRate: number; tipRate: number }> {
    let incRate = DEFAULT_INC_RATE;
    let tipRate = DEFAULT_TIP_RATE;
    try {
      const inc = await this.tax.resolveRate('INC_8');
      if (typeof inc.rate === 'number') incRate = inc.rate;
    } catch (err) {
      // fallback al default del módulo, pero visible: la tarifa parametrizada no
      // se pudo resolver (sin sembrar, error de BD, etc.).
      this.logger.warn(
        `No se pudo resolver la tarifa INC_8 parametrizada; se usa el default ${DEFAULT_INC_RATE}. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      const tip = await this.params.resolve('propina.sugerida');
      if (typeof tip.value === 'number') tipRate = tip.value;
    } catch (err) {
      // fallback al default del módulo, pero visible.
      this.logger.warn(
        `No se pudo resolver la propina sugerida parametrizada; se usa el default ${DEFAULT_TIP_RATE}. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { incRate, tipRate };
  }

  // ── Mesas ──────────────────────────────────────────────────────────────────

  async listTables(
    user: JwtUser,
    sedeId?: string,
  ): Promise<RestaurantTableDocument[]> {
    const filter: Record<string, unknown> = {};
    const scope = this.resolveScope(user, sedeId);
    if (scope) {
      filter.sedeId = { $in: scope.map((id) => new Types.ObjectId(id)) };
    }
    return this.tables.find(filter).sort({ zone: 1, name: 1 }).exec();
  }

  async createTable(
    dto: CreateTableDto,
    user: JwtUser,
  ): Promise<RestaurantTableDocument> {
    assertSedeAccess(user, dto.sedeId);
    return this.tables.create({
      sedeId: new Types.ObjectId(dto.sedeId),
      name: dto.name,
      zone: dto.zone?.trim() || 'Principal',
      seats: dto.seats ?? 4,
      status: 'free',
    });
  }

  async updateTable(
    id: string,
    dto: UpdateTableDto,
    user: JwtUser,
  ): Promise<RestaurantTableDocument> {
    const table = await this.tableOrFail(id, user);
    if (dto.name !== undefined) table.name = dto.name;
    if (dto.zone !== undefined) table.zone = dto.zone;
    if (dto.seats !== undefined) table.seats = dto.seats;
    if (dto.active !== undefined) table.active = dto.active;
    await table.save();
    return table;
  }

  async deleteTable(id: string, user: JwtUser): Promise<void> {
    const table = await this.tableOrFail(id, user);
    if (table.status !== 'free' || table.currentOrderId) {
      throw new BadRequestException('No se elimina una mesa ocupada');
    }
    await table.deleteOne();
  }

  // ── Comandas ────────────────────────────────────────────────────────────────

  async listOrders(
    user: JwtUser,
    query: { sedeId?: string; status?: string },
  ): Promise<RestaurantOrderDocument[]> {
    const filter: Record<string, unknown> = {};
    const scope = this.resolveScope(user, query.sedeId);
    if (scope) {
      filter.sedeId = { $in: scope.map((id) => new Types.ObjectId(id)) };
    }
    if (query.status) filter.status = query.status;
    return this.orders.find(filter).sort({ createdAt: -1 }).exec();
  }

  async getOrder(id: string, user: JwtUser): Promise<RestaurantOrderDocument> {
    const order = await this.orders.findById(id).exec();
    if (!order) throw new NotFoundException('Comanda no encontrada');
    assertSedeAccess(user, order.sedeId.toString());
    return order;
  }

  /** Abre una comanda en una mesa libre y la marca ocupada. */
  async openOrder(
    dto: OpenOrderDto,
    user: JwtUser,
  ): Promise<RestaurantOrderDocument> {
    const table = await this.tableOrFail(dto.tableId, user);
    if (!table.active) throw new BadRequestException('La mesa está inactiva');
    if (table.status !== 'free' || table.currentOrderId) {
      throw new BadRequestException('La mesa ya tiene una comanda abierta');
    }
    const { incRate, tipRate } = await this.resolveRates();
    const order = await this.orders.create({
      number: await this.nextNumber(),
      sedeId: table.sedeId,
      tableId: table._id,
      tableName: table.name,
      zone: table.zone,
      guests: dto.guests ?? 1,
      status: 'open',
      items: [],
      subtotal: 0,
      incRate,
      incAmount: 0,
      tipRate,
      tipAccepted: true,
      tipAmount: 0,
      total: 0,
      waiterEmail: user.email,
    });
    table.status = 'occupied';
    table.currentOrderId = order._id;
    await table.save();
    return order;
  }

  async addItems(
    id: string,
    dto: AddItemsDto,
    user: JwtUser,
  ): Promise<RestaurantOrderDocument> {
    const order = await this.getOrder(id, user);
    this.assertEditable(order);
    for (const it of dto.items) {
      order.items.push({
        productId: it.productId ? new Types.ObjectId(it.productId) : undefined,
        name: it.name,
        qty: it.qty,
        unitPrice: it.unitPrice,
        note: it.note,
        station: it.station,
        sentToKitchen: false,
      } as unknown as (typeof order.items)[number]);
    }
    this.recomputeTotals(order);
    await order.save();
    return order;
  }

  async removeItem(
    id: string,
    itemId: string,
    user: JwtUser,
  ): Promise<RestaurantOrderDocument> {
    const order = await this.getOrder(id, user);
    this.assertEditable(order);
    // Los ítems son subdocumentos con _id propio (schema con _id:true).
    const items = order.items as unknown as (OrderItemWithId)[];
    const idx = items.findIndex((i) => i._id.toString() === itemId);
    if (idx === -1) {
      throw new NotFoundException('Ítem no encontrado en la comanda');
    }
    if (items[idx]!.sentToKitchen) {
      throw new BadRequestException(
        'No se elimina un ítem ya enviado a cocina; anúlalo con autorización',
      );
    }
    order.items.splice(idx, 1);
    this.recomputeTotals(order);
    await order.save();
    return order;
  }

  /** Envía a cocina: marca los ítems pendientes e imprime comanda (estado). */
  async sendToKitchen(
    id: string,
    user: JwtUser,
  ): Promise<RestaurantOrderDocument> {
    const order = await this.getOrder(id, user);
    if (order.status === 'closed' || order.status === 'cancelled') {
      throw new BadRequestException('La comanda ya está cerrada');
    }
    const pending = order.items.filter((i) => !i.sentToKitchen);
    if (pending.length === 0) {
      throw new BadRequestException('No hay ítems nuevos por enviar a cocina');
    }
    for (const i of pending) i.sentToKitchen = true;
    order.status = 'sent';
    order.sentAt = new Date();
    await order.save();
    return order;
  }

  /** El cliente pide la cuenta. */
  async requestBill(
    id: string,
    user: JwtUser,
  ): Promise<RestaurantOrderDocument> {
    const order = await this.getOrder(id, user);
    if (order.items.length === 0) {
      throw new BadRequestException('La comanda no tiene ítems');
    }
    if (order.status === 'closed' || order.status === 'cancelled') {
      throw new BadRequestException('La comanda ya está cerrada');
    }
    order.status = 'billed';
    order.billedAt = new Date();
    await order.save();
    await this.tables
      .updateOne({ _id: order.tableId }, { status: 'bill_requested' })
      .exec();
    return order;
  }

  /** Ajusta la propina: rechazarla (accepted=false) la deja en 0. */
  async setTip(
    id: string,
    dto: SetTipDto,
    user: JwtUser,
  ): Promise<RestaurantOrderDocument> {
    const order = await this.getOrder(id, user);
    this.assertNotClosed(order);
    if (dto.rate !== undefined) order.tipRate = dto.rate;
    if (dto.accepted !== undefined) order.tipAccepted = dto.accepted;
    this.recomputeTotals(order);
    await order.save();
    return order;
  }

  /**
   * Cierra la comanda (pagada) y libera la mesa.
   *
   * ADVERTENCIA (impacto contable/inventario): a diferencia del cobro del POS
   * (`orders.checkout`, sales module), este cierre NO genera una venta (Sale),
   * NO descuenta inventario y NO registra el efectivo en la caja de la sede.
   * Solo marca la comanda como 'closed', recalcula totales (INC + propina) y
   * libera la mesa. El módulo de restaurante gestiona mesas/comandas; el cobro
   * real (venta, stock, caja, ledger) se espera a través del POS. Cablear aquí
   * la generación de la venta requeriría inyectar SalesService/CatalogService,
   * resolver ítems de texto libre a productos vendibles del catálogo, exigir una
   * caja abierta y una guarda de concurrencia — y arriesga DOBLE CONTEO si la
   * comanda además se cobra por el POS. Decisión de negocio pendiente del dueño.
   */
  async closeOrder(
    id: string,
    user: JwtUser,
  ): Promise<RestaurantOrderDocument> {
    const order = await this.getOrder(id, user);
    if (order.status === 'closed' || order.status === 'cancelled') {
      throw new BadRequestException('La comanda ya está cerrada');
    }
    if (order.items.length === 0) {
      throw new BadRequestException('No se cierra una comanda vacía');
    }
    this.recomputeTotals(order);
    order.status = 'closed';
    order.closedAt = new Date();
    await order.save();
    await this.freeTable(order);
    return order;
  }

  async cancelOrder(
    id: string,
    dto: CancelOrderDto,
    user: JwtUser,
  ): Promise<RestaurantOrderDocument> {
    const order = await this.getOrder(id, user);
    if (order.status === 'closed') {
      throw new BadRequestException('No se anula una comanda ya cerrada');
    }
    order.status = 'cancelled';
    order.cancelReason = dto.reason;
    order.closedAt = new Date();
    await order.save();
    await this.freeTable(order);
    return order;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private recomputeTotals(order: RestaurantOrderDocument): void {
    const subtotal = order.items.reduce(
      (a, i) => a + Math.round(i.unitPrice * i.qty),
      0,
    );
    const incAmount = Math.round((subtotal * order.incRate) / 100);
    const tipAmount = order.tipAccepted
      ? Math.round((subtotal * order.tipRate) / 100)
      : 0;
    order.subtotal = subtotal;
    order.incAmount = incAmount;
    order.tipAmount = tipAmount;
    order.total = subtotal + incAmount + tipAmount;
  }

  private assertEditable(order: RestaurantOrderDocument): void {
    if (order.status === 'closed' || order.status === 'cancelled') {
      throw new BadRequestException('La comanda ya está cerrada');
    }
  }

  private assertNotClosed(order: RestaurantOrderDocument): void {
    if (order.status === 'closed' || order.status === 'cancelled') {
      throw new BadRequestException('La comanda ya está cerrada');
    }
  }

  private async freeTable(order: RestaurantOrderDocument): Promise<void> {
    await this.tables
      .updateOne(
        { _id: order.tableId },
        { status: 'free', currentOrderId: null },
      )
      .exec();
  }

  /**
   * Consecutivo de comanda vía $inc atómico (no requiere transacciones). Usa la
   * colección de contadores compartida con la clave `restaurant_order`,
   * evitando el reuso de números al borrar docs o bajo concurrencia (unique).
   */
  private async nextNumber(): Promise<string> {
    const counter = await this.counterModel
      .findOneAndUpdate(
        { _id: 'restaurant_order' },
        { $inc: { seq: 1 } },
        { upsert: true, new: true },
      )
      .exec();
    return `CMD-${String(counter.seq).padStart(6, '0')}`;
  }

  private async tableOrFail(
    id: string,
    user: JwtUser,
  ): Promise<RestaurantTableDocument> {
    const table = await this.tables.findById(id).exec();
    if (!table) throw new NotFoundException('Mesa no encontrada');
    assertSedeAccess(user, table.sedeId.toString());
    return table;
  }

  private resolveScope(user: JwtUser, sedeId?: string): string[] | null {
    if (sedeId) {
      assertSedeAccess(user, sedeId);
      return [sedeId];
    }
    return allowedSedeIds(user);
  }
}
