import {
  BadRequestException,
  Injectable,
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
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';
import {
  DEFAULT_INC_RATE,
  DEFAULT_TIP_RATE,
} from '../domain/restaurant.constants';
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
  constructor(
    @InjectModel(RestaurantTable.name)
    private readonly tables: Model<RestaurantTableDocument>,
    @InjectModel(RestaurantOrder.name)
    private readonly orders: Model<RestaurantOrderDocument>,
  ) {}

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
      incRate: DEFAULT_INC_RATE,
      incAmount: 0,
      tipRate: DEFAULT_TIP_RATE,
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

  /** Cierra la comanda (pagada) y libera la mesa. */
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

  private async nextNumber(): Promise<string> {
    const n = (await this.orders.estimatedDocumentCount().exec()) + 1;
    return `CMD-${String(n).padStart(6, '0')}`;
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
