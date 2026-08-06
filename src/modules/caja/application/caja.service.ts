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
import { Sede, SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { allowedSedeIds, assertSedeAccess } from '../../core-auth/domain/sede-access';
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

/** Resumen del día de la caja de una sede (para el panel del ERP). */
export interface CajaOverviewRow {
  sedeId: string;
  sedeName: string;
  /** 'none' = sin apertura hoy · 'open' = abierta · 'closed' = ya cerró. */
  status: 'none' | 'open' | 'closed';
  sessionId?: string;
  openingAmount?: number;
  openedAt?: Date;
  openedByEmail?: string;
  closedAt?: Date;
  closedByEmail?: string;
  countedAmount?: number;
  expectedCash?: number;
  difference?: number;
  salesCount: number;
  salesTotal: number;
  cashSalesTotal: number;
  movementsIn: number;
  movementsOut: number;
}

/** Fila de efectivo en vivo de un turno abierto (tesorería). */
export interface CajaLiveCashRow {
  sedeId: string;
  sedeName: string;
  sessionId: string;
  openingAmount: number;
  openedAt: Date;
  expectedCash: number;
  salesTotal: number;
}

export interface CajaLiveCash {
  rows: CajaLiveCashRow[];
  total: number;
}

export interface CajaOverview {
  date: string;
  rows: CajaOverviewRow[];
  totals: {
    sedes: number;
    openCount: number;
    closedCount: number;
    noneCount: number;
    openingTotal: number;
    salesCount: number;
    salesTotal: number;
    cashSalesTotal: number;
    expectedCashTotal: number;
  };
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
    @InjectModel(Sede.name)
    private readonly sedes: Model<SedeDocument>,
  ) {}

  /**
   * Resumen del día de todas las cajas (sedes) que el usuario puede ver:
   * con cuánto abrieron, si ya cerraron y con cuánto, y las ventas del turno.
   */
  async overview(user: JwtUser, date?: string): Promise<CajaOverview> {
    const todayStr = new Date().toLocaleDateString('en-CA');
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
      ? (date as string)
      : todayStr;
    const start = new Date(`${dateStr}T00:00:00`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const isToday = dateStr === todayStr;

    // Sedes visibles para el usuario (según su alcance).
    const allowed = allowedSedeIds(user);
    const sedeFilter: Record<string, unknown> = { active: true };
    if (allowed) {
      sedeFilter._id = { $in: allowed.map((id) => new Types.ObjectId(id)) };
    }
    const sedes = await this.sedes
      .find(sedeFilter)
      .sort({ name: 1 })
      .select('name')
      .exec();
    const sedeIds = sedes.map((s) => s._id);

    // Sesiones del día (abiertas hoy) + cualquiera abierta ahora (turno nocturno).
    const or: Record<string, unknown>[] = [
      { openedAt: { $gte: start, $lt: end } },
    ];
    if (isToday) or.push({ status: 'open' });
    const sessions = await this.sessions
      .find({ sedeId: { $in: sedeIds }, $or: or })
      .sort({ openedAt: -1 })
      .exec();

    // Sesión representativa por sede: la abierta; si no, la más reciente del día.
    const bySede = new Map<string, CajaSessionDocument>();
    for (const s of sessions) {
      const key = s.sedeId.toString();
      const prev = bySede.get(key);
      if (!prev) {
        bySede.set(key, s);
      } else if (prev.status !== 'open' && s.status === 'open') {
        bySede.set(key, s);
      }
    }

    const rows: CajaOverviewRow[] = [];
    for (const sede of sedes) {
      const session = bySede.get(sede._id.toString());
      if (!session) {
        rows.push({
          sedeId: sede._id.toString(),
          sedeName: sede.name,
          status: 'none',
          salesCount: 0,
          salesTotal: 0,
          cashSalesTotal: 0,
          movementsIn: 0,
          movementsOut: 0,
        });
        continue;
      }

      // Abierta: totales en vivo. Cerrada: totales congelados al cierre.
      let t: CajaTotals;
      if (session.status === 'open') {
        t = (await this.summarize(session)).totals;
      } else {
        t = {
          salesCount: session.salesCount ?? 0,
          salesTotal: session.salesTotal ?? 0,
          cashSalesTotal: session.cashSalesTotal ?? 0,
          movementsIn: session.movementsIn ?? 0,
          movementsOut: session.movementsOut ?? 0,
          expectedCash: session.expectedCash ?? 0,
        };
      }

      rows.push({
        sedeId: sede._id.toString(),
        sedeName: sede.name,
        status: session.status,
        sessionId: session._id.toString(),
        openingAmount: session.openingAmount,
        openedAt: session.openedAt,
        openedByEmail: session.openedByEmail,
        closedAt: session.closedAt,
        closedByEmail: session.closedByEmail,
        countedAmount: session.countedAmount,
        expectedCash: t.expectedCash,
        difference: session.difference,
        salesCount: t.salesCount,
        salesTotal: t.salesTotal,
        cashSalesTotal: t.cashSalesTotal,
        movementsIn: t.movementsIn,
        movementsOut: t.movementsOut,
      });
    }

    const totals = rows.reduce(
      (acc, r) => {
        acc.openCount += r.status === 'open' ? 1 : 0;
        acc.closedCount += r.status === 'closed' ? 1 : 0;
        acc.noneCount += r.status === 'none' ? 1 : 0;
        acc.openingTotal += r.openingAmount ?? 0;
        acc.salesCount += r.salesCount;
        acc.salesTotal += r.salesTotal;
        acc.cashSalesTotal += r.cashSalesTotal;
        acc.expectedCashTotal += r.expectedCash ?? 0;
        return acc;
      },
      {
        sedes: sedes.length,
        openCount: 0,
        closedCount: 0,
        noneCount: 0,
        openingTotal: 0,
        salesCount: 0,
        salesTotal: 0,
        cashSalesTotal: 0,
        expectedCashTotal: 0,
      },
    );

    return { date: dateStr, rows, totals };
  }

  /**
   * Efectivo en vivo de los turnos ABIERTOS del alcance (sin límite de día;
   * incluye turnos nocturnos). Es la fuente de verdad del efectivo para la
   * tesorería de Finanzas: `expectedCash` = lo que debería haber en cada cajón
   * ahora. No cuenta turnos cerrados (su efectivo se cuadra al cerrar).
   */
  async liveCash(user: JwtUser, sedeId?: string): Promise<CajaLiveCash> {
    const allowed = allowedSedeIds(user);
    const filter: Record<string, unknown> = { status: 'open' };
    if (sedeId) {
      assertSedeAccess(user, sedeId);
      filter.sedeId = new Types.ObjectId(sedeId);
    } else if (allowed) {
      filter.sedeId = { $in: allowed.map((id) => new Types.ObjectId(id)) };
    }
    const sessions = await this.sessions
      .find(filter)
      .sort({ openedAt: 1 })
      .exec();
    if (sessions.length === 0) return { rows: [], total: 0 };

    const sedeObjIds = [
      ...new Set(sessions.map((s) => s.sedeId.toString())),
    ].map((id) => new Types.ObjectId(id));
    const sedeDocs = await this.sedes
      .find({ _id: { $in: sedeObjIds } })
      .select('name')
      .exec();
    const nameOf = new Map(sedeDocs.map((s) => [s._id.toString(), s.name]));

    const rows: CajaLiveCashRow[] = [];
    let total = 0;
    for (const s of sessions) {
      const { totals } = await this.summarize(s);
      rows.push({
        sedeId: s.sedeId.toString(),
        sedeName: nameOf.get(s.sedeId.toString()) ?? '—',
        sessionId: s._id.toString(),
        openingAmount: s.openingAmount,
        openedAt: s.openedAt,
        expectedCash: totals.expectedCash,
        salesTotal: totals.salesTotal,
      });
      total += totals.expectedCash;
    }
    return { rows, total: Math.round(total) };
  }

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
    // El efectivo del cajón incluye la propina cobrada en efectivo (se paga
    // encima del total), por eso se suma `tip` para que el arqueo cuadre.
    const cashSalesTotal = sales
      .filter((s) => s.payment.method === 'cash')
      .reduce((a, s) => a + s.total + (s.tip ?? 0), 0);
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
