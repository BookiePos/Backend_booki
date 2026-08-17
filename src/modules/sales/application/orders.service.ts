import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../infrastructure/schemas/order.schema';
import { OrderStatus } from '../domain/order.constants';
import {
  Counter,
  CounterDocument,
} from '../infrastructure/schemas/counter.schema';
import {
  CajaSession,
  CajaSessionDocument,
} from '../../caja/infrastructure/schemas/caja-session.schema';
import { SedesService } from '../../sedes/application/sedes.service';
import { CatalogService } from '../../catalog/application/catalog.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { CreateOrderDto, OrderLineInputDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { CheckoutOrderDto } from './dto/checkout-order.dto';
import { SalesService } from './sales.service';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
    @InjectModel(CajaSession.name)
    private readonly cajaSessionModel: Model<CajaSessionDocument>,
    private readonly sedes: SedesService,
    private readonly catalog: CatalogService,
    private readonly sales: SalesService,
  ) {}

  /** El cajero solo opera sedes asignadas a su usuario (JWT). */
  private assertSedeAccess(sedeId: string, user: JwtUser): void {
    if (!user.sedeIds.includes(sedeId)) {
      throw new ForbiddenException('No tienes acceso a esta sede');
    }
  }

  /** Toda cuenta se abre dentro de un turno de caja (integridad contable). */
  private async assertCajaOpen(sedeId: string): Promise<void> {
    const open = await this.cajaSessionModel
      .findOne({ sedeId: new Types.ObjectId(sedeId), status: 'open' })
      .exec();
    if (!open) {
      throw new BadRequestException(
        'Debes abrir la caja de la sede antes de crear cuentas',
      );
    }
  }

  /** Consecutivo de cuentas por sede (independiente del de ventas). */
  private async nextOrderNumber(sedeId: string, sedeCode: string) {
    const counter = await this.counterModel
      .findOneAndUpdate(
        { _id: `order:${sedeId}` },
        { $inc: { seq: 1 } },
        { upsert: true, new: true },
      )
      .exec();
    return `${sedeCode.toUpperCase()}-C-${String(counter.seq).padStart(6, '0')}`;
  }

  /**
   * Resuelve los ítems a líneas con snapshot del catálogo (precio del servidor),
   * sumando las cantidades de un mismo producto.
   */
  private async buildLines(inputs: OrderLineInputDto[]) {
    const merged = new Map<string, number>();
    for (const l of inputs) {
      if (l.qty > 0) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.qty);
    }
    return Promise.all(
      [...merged.entries()].map(async ([productId, qty]) => {
        const product = await this.catalog.loadSellableOrFail(productId);
        return {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          unit: 'und',
          qty,
          unitPrice: product.salePrice,
          lineTotal: Math.round(product.salePrice * qty * 100) / 100,
        };
      }),
    );
  }

  async open(
    dto: CreateOrderDto,
    user: JwtUser,
    restaurantOrderId?: Types.ObjectId,
  ): Promise<OrderDocument> {
    this.assertSedeAccess(dto.sedeId, user);
    await this.assertCajaOpen(dto.sedeId);
    const sede = await this.sedes.findOrFail(dto.sedeId);
    const lines = dto.lines?.length ? await this.buildLines(dto.lines) : [];
    const orderNumber = await this.nextOrderNumber(dto.sedeId, sede.code);
    const created = await this.orderModel.create({
      orderNumber,
      sedeId: new Types.ObjectId(dto.sedeId),
      status: 'open',
      label: dto.label?.trim() || undefined,
      note: dto.note?.trim() || undefined,
      lines,
      openedById: user.userId,
      openedByEmail: user.email,
      restaurantOrderId,
    });
    return this.getOrFail(created.id);
  }

  /** Cuentas de una sede por estado (abiertas por defecto, recientes primero). */
  async list(sedeId: string, user: JwtUser, status: OrderStatus = 'open') {
    this.assertSedeAccess(sedeId, user);
    return this.orderModel
      .find({ sedeId: new Types.ObjectId(sedeId), status })
      .sort({ updatedAt: -1 })
      .populate('sedeId', 'code name')
      .exec();
  }

  async getOrFail(id: string): Promise<OrderDocument> {
    const order = Types.ObjectId.isValid(id)
      ? await this.orderModel
          .findById(id)
          .populate('sedeId', 'code name')
          .exec()
      : null;
    if (!order) throw new NotFoundException('Cuenta no encontrada');
    return order;
  }

  private assertOpen(order: OrderDocument): void {
    if (order.status !== 'open') {
      throw new BadRequestException('La cuenta ya no está abierta');
    }
  }

  private sedeIdOf(order: OrderDocument): string {
    return (order.sedeId as unknown as { _id: Types.ObjectId })._id.toString();
  }

  async update(
    id: string,
    dto: UpdateOrderDto,
    user: JwtUser,
  ): Promise<OrderDocument> {
    const order = await this.getOrFail(id);
    this.assertSedeAccess(this.sedeIdOf(order), user);
    this.assertOpen(order);

    if (dto.label !== undefined) order.label = dto.label.trim() || undefined;
    if (dto.note !== undefined) order.note = dto.note.trim() || undefined;
    if (dto.lines !== undefined) {
      order.lines = await this.buildLines(dto.lines);
    }
    await order.save();
    return this.getOrFail(order.id);
  }

  /**
   * Liquida la cuenta: crea la venta (descuenta inventario), la marca cerrada y
   * enlaza la venta. Devuelve la venta generada.
   */
  async checkout(id: string, dto: CheckoutOrderDto, user: JwtUser) {
    const order = await this.getOrFail(id);
    const sedeId = this.sedeIdOf(order);
    this.assertSedeAccess(sedeId, user);
    this.assertOpen(order);
    if (order.lines.length === 0) {
      throw new BadRequestException('La cuenta no tiene ítems para cobrar');
    }

    // Guarda de concurrencia (Mongo standalone, sin transacciones): "tomamos"
    // la cuenta de forma atómica ANTES de crear la venta. Solo el proceso que
    // gana el flip open→closed procede; dos cobros simultáneos ya no pueden
    // pasar ambos → se evita la doble venta y el doble descuento de stock.
    const closedAt = new Date();
    const claimed = await this.orderModel
      .findOneAndUpdate(
        { _id: order._id, status: 'open' },
        { $set: { status: 'closed', closedAt } },
        { new: true },
      )
      .exec();
    if (!claimed) {
      throw new ConflictException('La cuenta ya fue cobrada');
    }

    let sale: Awaited<ReturnType<SalesService['create']>>;
    try {
      sale = await this.sales.create(
        {
          sedeId,
          lines: order.lines.map((l) => ({
            productId: l.productId.toString(),
            qty: l.qty,
          })),
          payment: dto.payment,
          discount: dto.discount,
          customer: dto.customer,
          tip: dto.tip,
        },
        user,
        order._id as Types.ObjectId,
      );
    } catch (err) {
      // La venta falló: liberamos la cuenta para que pueda reintentarse el cobro.
      await this.orderModel
        .updateOne(
          { _id: order._id },
          { $set: { status: 'open' }, $unset: { closedAt: '' } },
        )
        .exec();
      throw err;
    }

    // Enlaza la venta a la cuenta ya cerrada.
    await this.orderModel
      .updateOne(
        { _id: order._id },
        { $set: { saleId: sale._id as Types.ObjectId } },
      )
      .exec();
    return sale;
  }

  /** Cierra la cuenta sin cobrar (no toca inventario: nunca se descontó). */
  async void(id: string, user: JwtUser): Promise<OrderDocument> {
    const order = await this.getOrFail(id);
    this.assertSedeAccess(this.sedeIdOf(order), user);
    this.assertOpen(order);
    order.status = 'void';
    order.closedAt = new Date();
    await order.save();
    return this.getOrFail(order.id);
  }
}
