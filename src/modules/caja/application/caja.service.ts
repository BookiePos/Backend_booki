import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import {
  CajaSession,
  CajaSessionDocument,
} from '../infrastructure/schemas/caja-session.schema';
import {
  CajaMovement,
  CajaMovementDocument,
} from '../infrastructure/schemas/caja-movement.schema';
import { Sale, SaleDocument } from '../../sales/infrastructure/schemas/sale.schema';
import { Order, OrderDocument } from '../../sales/infrastructure/schemas/order.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { OpenCajaDto } from './dto/open-caja.dto';
import { CloseCajaDto } from './dto/close-caja.dto';
import { CajaMovementDto } from './dto/caja-movement.dto';

/** Totales calculados de un turno de caja. */
export interface CajaTotals {
  salesCount: number;
  salesTotal: number;
  cashSalesTotal: number;
  movementsIn: number;
  movementsOut: number;
  /** Efectivo que debería haber: base + ventas efectivo + ingresos − salidas. */
  expectedCash: number;
}

@Injectable()
export class CajaService {
  constructor(
    @InjectModel(CajaSession.name)
    private readonly sessions: Model<CajaSessionDocument>,
    @InjectModel(CajaMovement.name)
    private readonly movements: Model<CajaMovementDocument>,
    @InjectModel(Sale.name)
    private readonly sales: Model<SaleDocument>,
    @InjectModel(Order.name)
    private readonly orders: Model<OrderDocument>,
  ) {}

  private findOpen(sedeId: string): Promise<CajaSessionDocument | null> {
    return this.sessions
      .findOne({ sedeId: new Types.ObjectId(sedeId), status: 'open' })
      .exec();
  }

  /** Estado actual de la caja de una sede (abierta o no) con sus totales. */
  async current(sedeId: string, user: JwtUser) {
    assertSedeAccess(user, sedeId);
    const session = await this.findOpen(sedeId);
    if (!session) return { session: null, totals: null, movements: [] };
    const { totals, movements } = await this.summarize(session);
    return { session, totals, movements };
  }

  async open(dto: OpenCajaDto, user: JwtUser): Promise<CajaSessionDocument> {
    assertSedeAccess(user, dto.sedeId);
    if (await this.findOpen(dto.sedeId)) {
      throw new ConflictException('Ya hay una caja abierta en esta sede');
    }
    try {
      return await this.sessions.create({
        sedeId: new Types.ObjectId(dto.sedeId),
        status: 'open',
        openingAmount: dto.openingAmount,
        openingBills: dto.openingBills,
        openingCoins: dto.openingCoins,
        openedById: user.userId,
        openedByEmail: user.email,
        openedAt: new Date(),
        note: dto.note,
      });
    } catch {
      // Índice único parcial: dos aperturas concurrentes en la misma sede.
      throw new ConflictException('Ya hay una caja abierta en esta sede');
    }
  }

  async close(dto: CloseCajaDto, user: JwtUser): Promise<CajaSessionDocument> {
    assertSedeAccess(user, dto.sedeId);
    const session = await this.findOpen(dto.sedeId);
    if (!session) {
      throw new NotFoundException('No hay una caja abierta en esta sede');
    }
    // No se cierra el turno con cuentas abiertas sin liquidar (contabilidad).
    const openOrders = await this.orders
      .countDocuments({
        sedeId: new Types.ObjectId(dto.sedeId),
        status: 'open',
      })
      .exec();
    if (openOrders > 0) {
      throw new ConflictException(
        `Hay ${openOrders} cuenta(s) abierta(s) en esta sede. Cóbralas o ciérralas antes de cerrar la caja.`,
      );
    }
    const { totals } = await this.summarize(session);
    session.status = 'closed';
    session.closedAt = new Date();
    session.closedById = user.userId;
    session.closedByEmail = user.email;
    session.countedAmount = dto.countedAmount;
    session.countedBills = dto.countedBills;
    session.countedCoins = dto.countedCoins;
    session.expectedCash = totals.expectedCash;
    session.difference =
      Math.round((dto.countedAmount - totals.expectedCash) * 100) / 100;
    session.salesCount = totals.salesCount;
    session.salesTotal = totals.salesTotal;
    session.cashSalesTotal = totals.cashSalesTotal;
    session.movementsIn = totals.movementsIn;
    session.movementsOut = totals.movementsOut;
    session.closeNote = dto.note;
    await session.save();
    return session;
  }

  async movement(
    dto: CajaMovementDto,
    user: JwtUser,
  ): Promise<CajaMovementDocument> {
    assertSedeAccess(user, dto.sedeId);
    if (
      dto.type === 'sangria' &&
      !user.permissions.includes(PERMISSIONS.CAJA_SANGRIA)
    ) {
      throw new ForbiddenException('No tienes permiso para hacer sangrías');
    }
    const session = await this.findOpen(dto.sedeId);
    if (!session) {
      throw new NotFoundException('No hay una caja abierta en esta sede');
    }
    return this.movements.create({
      sessionId: session._id,
      sedeId: new Types.ObjectId(dto.sedeId),
      type: dto.type,
      amount: dto.amount,
      reason: dto.reason,
      note: dto.note,
      userId: user.userId,
      userEmail: user.email,
    });
  }

  /** Historial de turnos de la sede (abiertos y cerrados), paginado. */
  async history(sedeId: string, user: JwtUser, page = 1, limit = 20) {
    assertSedeAccess(user, sedeId);
    const filter = { sedeId: new Types.ObjectId(sedeId) };
    const capped = Math.min(Math.max(limit, 1), 100);
    const current = Math.max(page, 1);
    const [total, rows] = await Promise.all([
      this.sessions.countDocuments(filter).exec(),
      this.sessions
        .find(filter)
        .sort({ openedAt: -1 })
        .skip((current - 1) * capped)
        .limit(capped)
        .exec(),
    ]);
    return { total, page: current, limit: capped, rows };
  }

  /** Calcula ventas y movimientos del turno para el arqueo. */
  private async summarize(
    session: CajaSessionDocument,
  ): Promise<{ totals: CajaTotals; movements: CajaMovementDocument[] }> {
    const [sales, movements] = await Promise.all([
      this.sales
        .find({ cajaSessionId: session._id, status: 'completed' })
        .exec(),
      this.movements
        .find({ sessionId: session._id })
        .sort({ createdAt: -1 })
        .exec(),
    ]);
    const salesTotal = sales.reduce((a, s) => a + s.total, 0);
    const cashSalesTotal = sales
      .filter((s) => s.payment.method === 'cash')
      .reduce((a, s) => a + s.total, 0);
    const movementsIn = movements
      .filter((m) => m.type === 'in')
      .reduce((a, m) => a + m.amount, 0);
    const movementsOut = movements
      .filter((m) => m.type !== 'in')
      .reduce((a, m) => a + m.amount, 0);
    const expectedCash =
      session.openingAmount + cashSalesTotal + movementsIn - movementsOut;
    return {
      totals: {
        salesCount: sales.length,
        salesTotal,
        cashSalesTotal,
        movementsIn,
        movementsOut,
        expectedCash,
      },
      movements,
    };
  }
}
