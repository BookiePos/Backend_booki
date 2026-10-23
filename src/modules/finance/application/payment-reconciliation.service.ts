import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../../sales/infrastructure/schemas/sale.schema';
import { Sede, SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import { BusinessService } from '../../control/application/business.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { ivaDescontablePorSede } from '../../core-tax/application/perfil-fiscal';
import { TreasuryPostingService } from '../treasury/treasury-posting.service';
import {
  PaymentSettlement,
  PaymentSettlementDocument,
} from '../infrastructure/schemas/payment-settlement.schema';
import {
  ExpectedRow,
  ParsedStatement,
  RECON_CHANNEL_LABEL,
  expectedByDay,
  mergeSettlementItems,
  parseStatementCsv,
  reconKey,
  settlementDifference,
} from '../domain/payment-reconciliation';
import { cop } from '../domain/money.util';
import { CreateSettlementsDto, ImportStatementDto } from './dto/payment-reconciliation.dto';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Tope del rango para que una consulta no recorra todo el historial. */
const MAX_DAYS = 93;

export interface SettlementView {
  id: string;
  statementAmount: number;
  commission: number;
  commissionIva: number;
  retefuente: number;
  reteIca: number;
  reteIva: number;
  difference: number;
  status: 'reconciled' | 'difference';
  source: 'manual' | 'csv';
  note?: string;
}

export interface ReconciliationRow extends ExpectedRow {
  settlement: SettlementView | null;
}

/**
 * Conciliación de pagos digitales (ítem 6.4): cruza lo cobrado por el POS en
 * cada canal contra el extracto del adquirente o la billetera. El servidor
 * recalcula lo cobrado; el cliente solo aporta lo que dice el extracto.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    @InjectModel(Sale.name) private readonly sales: Model<SaleDocument>,
    @InjectModel(PaymentSettlement.name)
    private readonly settlements: Model<PaymentSettlementDocument>,
    @InjectModel(Sede.name) private readonly sedeModel: Model<SedeDocument>,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly treasury: TreasuryPostingService,
    private readonly businesses: BusinessService,
  ) {}

  private range(from: string, to: string): { gte: Date; lt: Date } {
    if (!YYYYMMDD.test(from) || !YYYYMMDD.test(to) || from > to) {
      throw new BadRequestException('Rango de fechas inválido (YYYY-MM-DD)');
    }
    // Colombia no tiene horario de verano: -05:00 todo el año.
    const gte = new Date(`${from}T00:00:00-05:00`);
    const lt = new Date(new Date(`${to}T00:00:00-05:00`).getTime() + DAY_MS);
    if ((lt.getTime() - gte.getTime()) / DAY_MS > MAX_DAYS) {
      throw new BadRequestException(`El rango no puede pasar de ${MAX_DAYS} días`);
    }
    return { gte, lt };
  }

  private async expected(sedeId: string, from: string, to: string): Promise<ExpectedRow[]> {
    const { gte, lt } = this.range(from, to);
    const sales = await this.sales
      .find({
        sedeId: new Types.ObjectId(sedeId),
        status: 'completed',
        createdAt: { $gte: gte, $lt: lt },
      })
      .select('total tip deliveryFee payment payments createdAt')
      .lean()
      .exec();
    return expectedByDay(
      sales.map((s) => ({
        total: s.total,
        tip: s.tip,
        deliveryFee: s.deliveryFee,
        payment: s.payment,
        payments: s.payments,
        createdAt: (s as unknown as { createdAt: Date }).createdAt,
      })),
      fechaColombia,
    );
  }

  private view(d: PaymentSettlementDocument): SettlementView {
    return {
      id: d._id.toString(),
      statementAmount: d.statementAmount,
      commission: d.commission,
      commissionIva: d.commissionIva,
      retefuente: d.retefuente,
      reteIca: d.reteIca,
      reteIva: d.reteIva,
      difference: d.difference,
      status: d.status,
      source: d.source,
      note: d.note,
    };
  }

  /** Cobrado por canal y día, con su conciliación si ya existe. */
  async list(user: JwtUser, query: { sedeId: string; from: string; to: string }) {
    assertSedeAccess(user, query.sedeId);
    const expected = await this.expected(query.sedeId, query.from, query.to);
    const done = await this.settlements
      .find({ sedeId: new Types.ObjectId(query.sedeId), date: { $gte: query.from, $lte: query.to } })
      .exec();
    const byId = new Map(done.map((d) => [`${d.date}|${d.key}`, d]));
    const rows: ReconciliationRow[] = expected.map((e) => {
      const d = byId.get(`${e.date}|${e.key}`);
      byId.delete(`${e.date}|${e.key}`);
      return { ...e, settlement: d ? this.view(d) : null };
    });
    // Conciliaciones de un día sin ventas vivas (se anularon después): visibles.
    for (const d of byId.values()) {
      rows.push({
        date: d.date,
        channel: d.channel,
        franchise: d.franchise,
        key: d.key,
        expected: 0,
        tickets: 0,
        settlement: this.view(d),
      });
    }
    rows.sort((a, b) =>
      a.date === b.date ? a.key.localeCompare(b.key) : a.date.localeCompare(b.date),
    );
    const sum = (f: (r: ReconciliationRow) => number) => rows.reduce((a, r) => a + f(r), 0);
    return {
      rows,
      totals: {
        expected: cop(sum((r) => r.expected)),
        statementAmount: cop(sum((r) => r.settlement?.statementAmount ?? 0)),
        fees: cop(
          sum((r) => (r.settlement ? r.settlement.commission + r.settlement.commissionIva : 0)),
        ),
        retentions: cop(
          sum((r) =>
            r.settlement ? r.settlement.retefuente + r.settlement.reteIca + r.settlement.reteIva : 0,
          ),
        ),
        pending: rows.filter((r) => !r.settlement && r.expected > 0).length,
        withDifference: rows.filter((r) => r.settlement?.status === 'difference').length,
      },
    };
  }

  /** Lee el CSV y lo cruza con lo cobrado, sin guardar nada. */
  async previewImport(user: JwtUser, dto: ImportStatementDto) {
    assertSedeAccess(user, dto.sedeId);
    const parsed: ParsedStatement = parseStatementCsv(dto.csv, dto.channel);
    parsed.rows = mergeSettlementItems(parsed.rows);
    if (parsed.rows.length === 0) return { rows: [], errors: parsed.errors };
    const dates = parsed.rows.map((r) => r.date).sort();
    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    const expected = await this.expected(dto.sedeId, first, last);
    const exp = new Map(expected.map((e) => [`${e.date}|${e.key}`, e]));
    const done = await this.settlements
      .find({ sedeId: new Types.ObjectId(dto.sedeId), date: { $gte: first, $lte: last } })
      .select('date key')
      .lean()
      .exec();
    const existing = new Set(done.map((d) => `${d.date}|${d.key}`));
    const rows = parsed.rows.map((r) => {
      const key = reconKey(r.channel, r.franchise);
      const e = exp.get(`${r.date}|${key}`);
      const expectedAmount = e?.expected ?? 0;
      return {
        ...r,
        key,
        expected: expectedAmount,
        tickets: e?.tickets ?? 0,
        alreadyReconciled: existing.has(`${r.date}|${key}`),
        difference: settlementDifference({ ...r, expected: expectedAmount }),
      };
    });
    return { rows, errors: parsed.errors };
  }

  /** Guarda las conciliaciones y asienta comisión, IVA y retenciones. */
  async create(user: JwtUser, dto: CreateSettlementsDto) {
    assertSedeAccess(user, dto.sedeId);
    const items = mergeSettlementItems(dto.items);
    const dates = items.map((i) => i.date).sort();
    const expected = await this.expected(dto.sedeId, dates[0]!, dates[dates.length - 1]!);
    const exp = new Map(expected.map((e) => [`${e.date}|${e.key}`, e]));
    const descuentaIva = (
      await ivaDescontablePorSede({ sedes: this.sedeModel, businesses: this.businesses })
    )(dto.sedeId);

    const created: SettlementView[] = [];
    const skipped: { date: string; key: string; reason: string }[] = [];
    for (const item of items) {
      const franchise = item.channel === 'datafono' ? (item.franchise ?? '') : '';
      const key = reconKey(item.channel, franchise);
      const e = exp.get(`${item.date}|${key}`);
      if (!e) {
        skipped.push({ date: item.date, key, reason: 'No hubo cobros de ese canal ese día' });
        continue;
      }
      const figures = {
        expected: e.expected,
        statementAmount: cop(item.statementAmount),
        commission: cop(item.commission ?? 0),
        commissionIva: cop(item.commissionIva ?? 0),
        retefuente: cop(item.retefuente ?? 0),
        reteIca: cop(item.reteIca ?? 0),
        reteIva: cop(item.reteIva ?? 0),
      };
      const difference = settlementDifference(figures);
      let doc: PaymentSettlementDocument;
      try {
        doc = await this.settlements.create({
          sedeId: new Types.ObjectId(dto.sedeId),
          date: item.date,
          channel: item.channel,
          franchise,
          key,
          tickets: e.tickets,
          ...figures,
          difference,
          status: difference === 0 ? 'reconciled' : 'difference',
          source: dto.source,
          note: item.note,
          createdByEmail: user.email,
        });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          skipped.push({ date: item.date, key, reason: 'Ya estaba conciliado' });
          continue;
        }
        throw err;
      }
      const label = `${RECON_CHANNEL_LABEL[item.channel]}${franchise ? ` ${franchise}` : ''} ${item.date}`;
      const id = doc._id.toString();
      const asentado = await this.ledgerPosting.postPaymentSettlement({
        settlementId: id,
        label,
        date: fechaColombia(),
        sedeId: dto.sedeId,
        commission: figures.commission,
        commissionIva: figures.commissionIva,
        ivaDescontable: descuentaIva,
        retefuente: figures.retefuente,
        reteIca: figures.reteIca,
        reteIva: figures.reteIva,
        userEmail: user.email,
      });
      if (asentado === false) {
        // Sin asiento no se deja «conciliado»: se borra el registro y se
        // avisa para que se reintente (el fallo ya quedó en el log de CONCILIAR).
        this.logger.error(
          `CONCILIAR: se revierte la conciliación ${id} (${label}): no se pudo postear el asiento`,
        );
        await this.settlements.deleteOne({ _id: doc._id }).exec();
        skipped.push({
          date: item.date,
          key,
          reason: 'No se pudo registrar el asiento contable; vuelve a intentarlo',
        });
        continue;
      }
      // La cuenta de tesorería recibió el bruto con la venta: sale lo que el
      // extracto no consignó por comisión, IVA y retenciones.
      const out =
        figures.commission +
        figures.commissionIva +
        figures.retefuente +
        figures.reteIca +
        figures.reteIva;
      await this.treasury.post({
        sourceType: 'payment_settlement',
        sourceId: id,
        sedeId: dto.sedeId,
        method: item.channel === 'datafono' ? 'card' : 'transfer',
        channel: item.channel,
        direction: 'out',
        amount: out,
        date: fechaColombia(),
        concept: `Comisión y retenciones: ${label}`,
      });
      created.push(this.view(doc));
    }
    return { created, skipped };
  }

  /** Deshace una conciliación: contra-asiento y movimiento de tesorería. */
  async remove(user: JwtUser, id: string): Promise<{ deleted: boolean }> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Conciliación no encontrada');
    const doc = await this.settlements.findById(id).exec();
    if (!doc) throw new NotFoundException('Conciliación no encontrada');
    assertSedeAccess(user, doc.sedeId.toString());
    await this.ledgerPosting.reversePaymentSettlement(id, user.email);
    await this.treasury.reverse('payment_settlement', id);
    await this.settlements.deleteOne({ _id: doc._id }).exec();
    return { deleted: true };
  }
}
