import {
  BadRequestException,
  ConflictException,
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
  ACC,
  ORIGENES_IVA_INC_VIEJO,
  cuentaVigente,
} from '../domain/ledger.constants';
import { cop, sumBy } from '../../finance/domain/money.util';
import {
  INDICE_ORIGEN_VIVO,
  INDICE_UNA_REVERSA,
  esDuplicadoEn,
  esOrigenReservado,
} from '../domain/journal-entry.indices';
import { CreateAccountDto, CreateJournalEntryDto } from './dto/ledger.dto';
import {
  Counter,
  CounterDocument,
} from '../../sales/infrastructure/schemas/counter.schema';
import { fechaColombia, fechaDeReversa } from '../domain/fecha-contable';

/** Clave del consecutivo de asientos en `counters` (uno por empresa). */
const CONTADOR_ASIENTOS = 'ledger:asiento';
/** Choques seguidos sobre `number` antes de rendirse. */
const INTENTOS_NUMERO = 5;
const INDICE_NUMERO = { keys: { number: 1 }, options: { name: 'number_1' } };

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

/**
 * El asiento ya tiene su contra-asiento. Es un 400 para la API, pero quien
 * reversa por origen (anular una venta, editar un gasto) lo toma como hecho.
 */
export class AsientoYaReversadoException extends BadRequestException {
  constructor() {
    super('Este asiento ya fue reversado');
  }
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
    @InjectModel(Counter.name)
    private readonly counters: Model<CounterDocument>,
  ) {}

  // ── Plan de cuentas ─────────────────────────────────────────────────────────

  /**
   * Asegura que el plan base exista, cuenta por cuenta. Antes solo sembraba si
   * la empresa no tenía ninguna cuenta `system`, así que una empresa creada
   * con un plan anterior nunca recibía las cuentas nuevas (2408/2495) y `post`
   * fallaba con «Cuentas inexistentes», error que `safePost` se traga: la venta
   * quedaba sin asiento en silencio.
   *
   * Upsert por código con `$setOnInsert`: inserta solo lo que falta y nunca
   * pisa una cuenta existente (nombre, tipo ni estado). Es idempotente y
   * tolera dos requests sembrando a la vez (el `code` es único).
   */
  private async seedAccounts(): Promise<void> {
    const codes = SEED_ACCOUNTS.map((a) => a.code);
    const found = await this.accounts
      .find({ code: { $in: codes } })
      .select('code')
      .exec();
    const have = new Set(found.map((a) => a.code));
    const missing = SEED_ACCOUNTS.filter((a) => !have.has(a.code));
    if (missing.length === 0) return;
    await this.accounts.bulkWrite(
      missing.map((a) => ({
        updateOne: {
          filter: { code: a.code },
          update: {
            $setOnInsert: {
              code: a.code,
              name: a.name,
              type: a.type,
              system: true,
              active: true,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
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

  /**
   * Siguiente consecutivo AS-n, de un contador atómico por empresa ($inc). El
   * conteo de documentos que se usaba antes daba el mismo número a dos posteos
   * simultáneos. La primera vez el contador arranca en el mayor consecutivo
   * existente, así no repite números de asientos anteriores.
   */
  private async nextNumber(): Promise<string> {
    const siguiente = () =>
      this.counters
        .findOneAndUpdate(
          { _id: CONTADOR_ASIENTOS },
          { $inc: { seq: 1 } },
          { new: true },
        )
        .exec();
    let c = await siguiente();
    if (!c) {
      try {
        await this.counters.create({
          _id: CONTADOR_ASIENTOS,
          seq: await this.mayorConsecutivo(),
        });
      } catch (err) {
        // Otro posteo lo inicializó a la vez: sirve el suyo.
        if ((err as { code?: number }).code !== 11000) throw err;
      }
      c = await siguiente();
    }
    if (!c) throw new Error('No se pudo reservar el consecutivo del asiento');
    return `AS-${String(c.seq).padStart(6, '0')}`;
  }

  /** Mayor n de los AS-n existentes (0 si no hay). Solo al estrenar el contador. */
  private async mayorConsecutivo(): Promise<number> {
    const [r] = await this.entries
      .aggregate<{ max: number }>([
        { $match: { number: { $regex: '^AS-[0-9]+$' } } },
        {
          $group: {
            _id: null,
            max: { $max: { $toInt: { $substrCP: ['$number', 3, 20] } } },
          },
        },
      ])
      .exec();
    return r?.max ?? 0;
  }

  /**
   * Crea el asiento con un consecutivo nuevo. Si el número ya está tomado
   * (un asiento creado antes de que existiera el contador, o el contador
   * quedó atrás), pide el siguiente: el índice único de `number` es quien
   * avisa.
   */
  private async crearConNumero(
    doc: Omit<JournalEntry, 'number'>,
  ): Promise<JournalEntryDocument> {
    for (let intento = 1; ; intento++) {
      const number = await this.nextNumber();
      try {
        return await this.entries.create({ ...doc, number });
      } catch (err) {
        if (!esDuplicadoEn(err, INDICE_NUMERO) || intento >= INTENTOS_NUMERO) {
          throw err;
        }
      }
    }
  }

  /**
   * Postea un asiento validando balance y existencia de cuentas. Es el único
   * punto de entrada para escribir en el ledger (desde la API o desde otros
   * módulos). No edita jamás un asiento existente.
   *
   * Idempotente por (sourceType, sourceId): si ya hay un asiento vivo de ese
   * origen, el índice único rechaza el nuevo y se devuelve el existente. Dos
   * posteos simultáneos del mismo origen los separa el índice (no una búsqueda
   * previa); y cada uno saca su propio consecutivo del contador atómico.
   */
  post(input: PostEntryInput): Promise<JournalEntryDocument> {
    return this.escribir(input, 'idempotente');
  }

  private async escribir(
    input: PostEntryInput,
    siDuplicado: 'idempotente' | 'conflicto',
  ): Promise<JournalEntryDocument> {
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
      const debit = cop(l.debit ?? 0);
      const credit = cop(l.credit ?? 0);
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

    try {
      return await this.crearConNumero({
        date: input.date,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        memo: input.memo,
        lines,
        totalDebit,
        totalCredit,
        createdByEmail: input.createdByEmail,
      });
    } catch (err) {
      if (!input.sourceId || !esDuplicadoEn(err, INDICE_ORIGEN_VIVO)) throw err;
      if (siDuplicado === 'conflicto') {
        throw new ConflictException(
          `Ya hay un asiento vigente con el origen ${input.sourceType} ${input.sourceId}. Revérsalo o usa otra referencia.`,
        );
      }
      const existente = await this.findBySource(
        input.sourceType,
        input.sourceId,
      );
      if (!existente) throw err;
      return existente;
    }
  }

  async postFromDto(
    dto: CreateJournalEntryDto,
    userEmail?: string,
  ): Promise<JournalEntryDocument> {
    const sourceType = dto.sourceType ?? 'manual';
    if (esOrigenReservado(sourceType)) {
      throw new BadRequestException(
        `El origen «${sourceType}» lo usa el sistema; un asiento manual no puede llevarlo.`,
      );
    }
    return this.escribir(
      {
        date: dto.date,
        sourceType,
        sourceId: dto.sourceId,
        memo: dto.memo,
        lines: dto.lines,
        createdByEmail: userEmail,
      },
      'conflicto',
    );
  }

  async listEntries(query: {
    from?: string;
    to?: string;
    sourceType?: string;
    accountCode?: string;
    limit?: number;
    /**
     * Alcance por sede: solo asientos cuyos renglones caen TODOS en estas sedes.
     * Lista vacía (o sin ids válidos) devuelve [] sin consultar.
     */
    sedeIds?: readonly string[];
  }): Promise<JournalEntryDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.sedeIds) {
      const ids = query.sedeIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (ids.length === 0) return [];
      // `$nin` también casa con renglones sin sedeId: esos (nivel empresa)
      // quedan fuera, igual que un renglón de otra sede.
      filter['lines.0'] = { $exists: true };
      filter.lines = { $not: { $elemMatch: { sedeId: { $nin: ids } } } };
    }
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

  /**
   * IVA descontable de las recepciones de compra en el rango+sede: débitos
   * menos créditos a la 2408 de `purchase_receipt` y de sus contra-asientos.
   * Es la única constancia persistida del IVA de cada recepción. Lo lee el P&L.
   */
  async ivaDescontableDeCompras(
    range: { from: string; to: string },
    sedeIds: string[] | null,
  ): Promise<number> {
    const docs = await this.entries
      .find({
        date: { $gte: range.from, $lte: range.to },
        sourceType: { $in: ['purchase_receipt', 'reversal:purchase_receipt'] },
        'lines.accountCode': ACC.IVA_POR_PAGAR,
      })
      .select('lines')
      .exec();
    const sedes = sedeIds ? new Set(sedeIds) : null;
    const lines = docs
      .flatMap((e) => e.lines)
      .filter(
        (l) =>
          l.accountCode === ACC.IVA_POR_PAGAR &&
          (!sedes || (l.sedeId != null && sedes.has(l.sedeId.toString()))),
      );
    return sumBy(lines, (l) => (l.debit || 0) - (l.credit || 0));
  }

  /**
   * Asiento VIVO de un evento de negocio (original y sin reversar), si existe.
   * Un original reversado no cuenta: tras editar un gasto su asiento viejo
   * queda reversado y el nuevo debe poder postearse.
   */
  async findBySource(
    sourceType: string,
    sourceId: string,
  ): Promise<JournalEntryDocument | null> {
    return this.entries
      .findOne({ sourceType, sourceId, reversalOf: null, reversedBy: null })
      .exec();
  }

  /** Reversa el asiento de un evento de negocio (p.ej. al anular una venta). */
  async reverseBySource(
    sourceType: string,
    sourceId: string,
    userEmail?: string,
  ): Promise<JournalEntryDocument | null> {
    const entry = await this.findBySource(sourceType, sourceId);
    if (!entry || entry.reversedBy) return null;
    try {
      return await this.reverse(entry._id.toString(), userEmail);
    } catch (err) {
      // Ya tiene su contra-asiento (otra reversa ganó la carrera, o una
      // anterior lo creó y no alcanzó a marcar el original: `reverse` ya
      // reparó el puntero). Si no se pudo reparar, el error sube y queda
      // pendiente de conciliar.
      if (err instanceof AsientoYaReversadoException) return null;
      throw err;
    }
  }

  /**
   * Reversa un asiento con un contra-asiento (débitos/créditos intercambiados).
   *
   * Su fecha la decide `fechaDeReversa`: la del original si es del mes en
   * curso; hoy si es de un mes anterior (orden cronológico, C. Co. art. 57;
   * E.T. art. 484), o la que se pida entre ambas. El P&L de finanzas no sigue
   * ese criterio en todo: ver la nota de `finance/domain/actuals.ts`.
   */
  async reverse(
    id: string,
    userEmail?: string,
    fechaPedida?: string,
  ): Promise<JournalEntryDocument> {
    const original = await this.getEntry(id);
    if (original.reversalOf) {
      throw new BadRequestException('No se reversa un contra-asiento');
    }
    if (original.reversedBy) {
      throw new AsientoYaReversadoException();
    }
    const fecha = fechaDeReversa(original.date, fechaColombia(), fechaPedida);
    if ('error' in fecha) throw new BadRequestException(fecha.error);
    const contra = await this
      .crearConNumero({
        date: fecha.fecha,
        sourceType: `reversal:${original.sourceType}`,
        sourceId: original.sourceId,
        memo: `Reversa de ${original.number} del ${original.date}${original.memo ? ` — ${original.memo}` : ''}`,
        // Un asiento posteado con el plan viejo (IVA/INC en 2367/2368) se
        // reversa contra la cuenta PUC vigente: la reclasificación ya movió ese
        // saldo, y devolverlo a la vieja la dejaría con un saldo deudor falso.
        // Solo los asientos automáticos de venta: en uno manual la 2367/2368 es
        // ReteIVA/ReteICA real y se reversa contra la misma cuenta.
        lines: original.lines.map((l) => {
          const code = ORIGENES_IVA_INC_VIEJO.includes(original.sourceType)
            ? cuentaVigente(l.accountCode)
            : l.accountCode;
          return {
            accountCode: code,
            accountName:
              code === l.accountCode
                ? l.accountName
                : (SEED_ACCOUNTS.find((a) => a.code === code)?.name ??
                  l.accountName),
            debit: l.credit,
            credit: l.debit,
            sedeId: l.sedeId,
            memo: l.memo,
          };
        }),
        totalDebit: original.totalCredit,
        totalCredit: original.totalDebit,
        reversalOf: original._id,
        reversedBy: null,
        createdByEmail: userEmail,
      })
      .catch(async (err: unknown) => {
        if (!esDuplicadoEn(err, INDICE_UNA_REVERSA)) throw err;
        // El índice `una_reversa_por_asiento` rechazó un segundo
        // contra-asiento: ya existe uno. Si el original quedó sin marcar (la
        // reversa anterior falló entre crear y guardar), se repara el puntero
        // para que deje de contar como vivo. Si la reparación falla, ese error
        // sube.
        const existente = await this.entries
          .findOne({ reversalOf: original._id })
          .exec();
        if (existente) {
          await this.entries
            .updateOne(
              { _id: original._id, reversedBy: null },
              { $set: { reversedBy: existente._id } },
            )
            .exec();
        }
        throw new AsientoYaReversadoException();
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
