import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import {
  LedgerAccount,
  LedgerAccountDocument,
} from '../infrastructure/schemas/ledger-account.schema';
import {
  JournalEntry,
  JournalEntryDocument,
} from '../infrastructure/schemas/journal-entry.schema';
import {
  ACCOUNT_TYPE_LABELS,
  AccountType,
  NATURAL_SIDE,
  SEED_ACCOUNTS,
} from '../domain/ledger.constants';
import { CreateAccountDto, CreateJournalEntryDto } from './dto/ledger.dto';

/** Renglón normalizado para postear un asiento (uso programático). */
export interface PostLine {
  accountCode: string;
  debit?: number;
  credit?: number;
  sedeId?: string;
  memo?: string;
}

export interface PostEntryInput {
  date: string;
  sourceType: string;
  sourceId?: string;
  memo?: string;
  lines: PostLine[];
  createdByEmail?: string;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: AccountType;
  typeLabel: string;
  debit: number;
  credit: number;
  balance: number;
}

@Injectable()
export class LedgerService {
  constructor(
    @InjectModel(LedgerAccount.name)
    private readonly accounts: Model<LedgerAccountDocument>,
    @InjectModel(JournalEntry.name)
    private readonly entries: Model<JournalEntryDocument>,
  ) {}

  // ── Plan de cuentas ─────────────────────────────────────────────────────────

  private async seedAccounts(): Promise<void> {
    const existing = await this.accounts.countDocuments({ system: true }).exec();
    if (existing > 0) return;
    await this.accounts.insertMany(
      SEED_ACCOUNTS.map((a) => ({
        code: a.code,
        name: a.name,
        type: a.type,
        system: true,
        active: true,
      })),
    );
  }

  async listAccounts(): Promise<LedgerAccountDocument[]> {
    await this.seedAccounts();
    return this.accounts.find().sort({ code: 1 }).exec();
  }

  async createAccount(dto: CreateAccountDto): Promise<LedgerAccountDocument> {
    await this.seedAccounts();
    const exists = await this.accounts.exists({ code: dto.code }).exec();
    if (exists) {
      throw new BadRequestException(`La cuenta ${dto.code} ya existe`);
    }
    return this.accounts.create({
      code: dto.code,
      name: dto.name,
      type: dto.type,
      system: false,
      active: true,
    });
  }

  // ── Asientos ────────────────────────────────────────────────────────────────

  private async nextNumber(): Promise<string> {
    const n = (await this.entries.estimatedDocumentCount().exec()) + 1;
    return `AS-${String(n).padStart(6, '0')}`;
  }

  /**
   * Postea un asiento validando balance y existencia de cuentas. Es el único
   * punto de entrada para escribir en el ledger (desde la API o desde otros
   * módulos). No edita jamás un asiento existente.
   */
  async post(input: PostEntryInput): Promise<JournalEntryDocument> {
    await this.seedAccounts();
    if (!input.lines || input.lines.length < 2) {
      throw new BadRequestException('Un asiento requiere al menos 2 renglones');
    }

    const codes = [...new Set(input.lines.map((l) => l.accountCode))];
    const found = await this.accounts.find({ code: { $in: codes } }).exec();
    const byCode = new Map(found.map((a) => [a.code, a]));
    const missing = codes.filter((c) => !byCode.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Cuentas inexistentes: ${missing.join(', ')}`,
      );
    }

    let totalDebit = 0;
    let totalCredit = 0;
    const lines = input.lines.map((l) => {
      const debit = Math.round(l.debit ?? 0);
      const credit = Math.round(l.credit ?? 0);
      if (debit < 0 || credit < 0) {
        throw new BadRequestException('Los montos no pueden ser negativos');
      }
      if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
        throw new BadRequestException(
          'Cada renglón usa débito O crédito (uno mayor que cero)',
        );
      }
      totalDebit += debit;
      totalCredit += credit;
      const account = byCode.get(l.accountCode)!;
      return {
        accountCode: account.code,
        accountName: account.name,
        debit,
        credit,
        sedeId: l.sedeId ? new Types.ObjectId(l.sedeId) : undefined,
        memo: l.memo,
      };
    });

    if (totalDebit !== totalCredit) {
      throw new BadRequestException(
        `Asiento descuadrado: débitos ${totalDebit} ≠ créditos ${totalCredit}`,
      );
    }

    const number = await this.nextNumber();
    return this.entries.create({
      number,
      date: input.date,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      memo: input.memo,
      lines,
      totalDebit,
      totalCredit,
      createdByEmail: input.createdByEmail,
    });
  }

  async postFromDto(
    dto: CreateJournalEntryDto,
    userEmail?: string,
  ): Promise<JournalEntryDocument> {
    return this.post({
      date: dto.date,
      sourceType: dto.sourceType ?? 'manual',
      sourceId: dto.sourceId,
      memo: dto.memo,
      lines: dto.lines,
      createdByEmail: userEmail,
    });
  }

  async listEntries(query: {
    from?: string;
    to?: string;
    sourceType?: string;
    accountCode?: string;
    limit?: number;
  }): Promise<JournalEntryDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.from || query.to) {
      const range: Record<string, string> = {};
      if (query.from) range.$gte = query.from;
      if (query.to) range.$lte = query.to;
      filter.date = range;
    }
    if (query.sourceType) filter.sourceType = query.sourceType;
    if (query.accountCode) filter['lines.accountCode'] = query.accountCode;
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    return this.entries
      .find(filter)
      .sort({ date: -1, createdAt: -1 })
      .limit(limit)
      .exec();
  }

  async getEntry(id: string): Promise<JournalEntryDocument> {
    const entry = await this.entries.findById(id).exec();
    if (!entry) throw new NotFoundException('Asiento no encontrado');
    return entry;
  }

  /** Reversa un asiento con un contra-asiento (débitos/créditos intercambiados). */
  async reverse(
    id: string,
    userEmail?: string,
  ): Promise<JournalEntryDocument> {
    const original = await this.getEntry(id);
    if (original.reversalOf) {
      throw new BadRequestException('No se reversa un contra-asiento');
    }
    if (original.reversedBy) {
      throw new BadRequestException('Este asiento ya fue reversado');
    }
    const number = await this.nextNumber();
    const contra = await this.entries.create({
      number,
      date: new Date().toLocaleDateString('en-CA'),
      sourceType: `reversal:${original.sourceType}`,
      sourceId: original.sourceId,
      memo: `Reversa de ${original.number}${original.memo ? ` — ${original.memo}` : ''}`,
      lines: original.lines.map((l) => ({
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit: l.credit,
        credit: l.debit,
        sedeId: l.sedeId,
        memo: l.memo,
      })),
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
      reversalOf: original._id,
      createdByEmail: userEmail,
    });
    // Único puntero mutable permitido: marcar el original como reversado.
    original.reversedBy = contra._id;
    await original.save();
    return contra;
  }

  // ── Reportes base ────────────────────────────────────────────────────────────

  /** Balance de comprobación: débitos/créditos y saldo por cuenta en el rango. */
  async trialBalance(query: {
    from?: string;
    to?: string;
    sedeId?: string;
  }): Promise<{
    from?: string;
    to?: string;
    rows: TrialBalanceRow[];
    totalDebit: number;
    totalCredit: number;
    balanced: boolean;
  }> {
    await this.seedAccounts();
    const match: Record<string, unknown> = {};
    if (query.from || query.to) {
      const range: Record<string, string> = {};
      if (query.from) range.$gte = query.from;
      if (query.to) range.$lte = query.to;
      match.date = range;
    }
    const pipeline: PipelineStage[] = [
      { $match: match },
      { $unwind: '$lines' },
    ];
    if (query.sedeId) {
      pipeline.push({
        $match: { 'lines.sedeId': new Types.ObjectId(query.sedeId) },
      });
    }
    pipeline.push({
      $group: {
        _id: '$lines.accountCode',
        debit: { $sum: '$lines.debit' },
        credit: { $sum: '$lines.credit' },
      },
    });
    const grouped = await this.entries.aggregate(pipeline).exec();
    const accounts = await this.listAccounts();
    const byCode = new Map(
      (grouped as { _id: string; debit: number; credit: number }[]).map((g) => [
        g._id,
        g,
      ]),
    );

    let totalDebit = 0;
    let totalCredit = 0;
    const rows: TrialBalanceRow[] = [];
    for (const acc of accounts) {
      const g = byCode.get(acc.code);
      if (!g || (g.debit === 0 && g.credit === 0)) continue;
      const natural = NATURAL_SIDE[acc.type];
      const balance =
        natural === 'debit' ? g.debit - g.credit : g.credit - g.debit;
      totalDebit += g.debit;
      totalCredit += g.credit;
      rows.push({
        code: acc.code,
        name: acc.name,
        type: acc.type,
        typeLabel: ACCOUNT_TYPE_LABELS[acc.type],
        debit: g.debit,
        credit: g.credit,
        balance,
      });
    }
    return {
      from: query.from,
      to: query.to,
      rows,
      totalDebit,
      totalCredit,
      balanced: totalDebit === totalCredit,
    };
  }
}
