import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  TaxRate,
  TaxRateDocument,
} from '../infrastructure/schemas/tax-rate.schema';
import {
  INC_BOLSAS_CODE,
  SEED_TAXES,
  TAX_KIND_LABELS,
  TaxBasis,
} from '../domain/tax.constants';
import {
  CreateTaxDto,
  SetTaxRateVersionDto,
  UpdateTaxDto,
} from './dto/tax.dto';
import { cop } from '../../finance/domain/money.util';

/** Impuesto con su tarifa vigente y su histórico de vigencias. */
export interface TaxView {
  code: string;
  name: string;
  kind: string;
  kindLabel: string;
  /** Porcentaje o pesos por unidad (INC de bolsas). */
  basis: TaxBasis;
  active: boolean;
  system: boolean;
  currentRate: number | null;
  currentFrom: string | null;
  history: {
    rate: number;
    effectiveFrom: string;
    note?: string;
    upcoming: boolean;
  }[];
}

/** Resultado de calcular un impuesto sobre una base. */
export interface TaxComputation {
  code: string;
  kind: string;
  base: number;
  rate: number;
  taxAmount: number;
  total: number;
  date: string;
}

@Injectable()
export class TaxService {
  constructor(
    @InjectModel(TaxRate.name)
    private readonly taxes: Model<TaxRateDocument>,
  ) {}

  /**
   * Fecha "hoy" (YYYY-MM-DD) fijada en la zona horaria de Colombia. Sin la zona,
   * un servidor en UTC resolvería mal las vigencias cerca de la medianoche local.
   */
  private today(): string {
    return new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Bogota',
    });
  }

  /**
   * Siembra los impuestos de ley que le falten a la empresa. Antes solo
   * sembraba si no había ninguno, y una empresa creada antes de un impuesto
   * nuevo (el INC de bolsas) nunca lo recibía. Inserta solo los códigos que no
   * existen y nunca pisa uno existente (ni su tarifa ni si está activo). Dos
   * requests a la vez chocan con el índice único `code + effectiveFrom`: el
   * duplicado se ignora.
   */
  private async seed(): Promise<void> {
    const have = new Set<string>(
      await this.taxes.distinct('code', { system: true }).exec(),
    );
    const missing = SEED_TAXES.filter((t) => !have.has(t.code));
    if (missing.length === 0) return;
    try {
      await this.taxes.insertMany(
        missing.map((t) => ({
          code: t.code,
          name: t.name,
          kind: t.kind,
          rate: t.rate,
          basis: t.basis ?? 'porcentaje',
          note: t.note,
          effectiveFrom: '2026-01-01',
          active: t.active ?? true,
          system: true,
        })),
        { ordered: false },
      );
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  async list(): Promise<TaxView[]> {
    await this.seed();
    const docs = await this.taxes
      .find()
      .sort({ code: 1, effectiveFrom: -1 })
      .exec();
    const today = this.today();
    const byCode = new Map<string, TaxRateDocument[]>();
    for (const d of docs) {
      const arr = byCode.get(d.code) ?? [];
      arr.push(d);
      byCode.set(d.code, arr);
    }
    const views: TaxView[] = [];
    for (const [code, versions] of byCode) {
      const head = versions[0];
      if (!head) continue;
      const current = versions.find((v) => v.effectiveFrom <= today) ?? null;
      views.push({
        code,
        name: head.name,
        kind: head.kind,
        kindLabel: TAX_KIND_LABELS[head.kind],
        basis: head.basis ?? 'porcentaje',
        active: head.active,
        system: head.system,
        currentRate: current ? current.rate : null,
        currentFrom: current ? current.effectiveFrom : null,
        history: versions.map((v) => ({
          rate: v.rate,
          effectiveFrom: v.effectiveFrom,
          note: v.note,
          upcoming: v.effectiveFrom > today,
        })),
      });
    }
    return views.sort((a, b) => a.code.localeCompare(b.code));
  }

  /** Resuelve la tarifa vigente de un impuesto a una fecha. */
  async resolveRate(code: string, date?: string): Promise<TaxRateDocument> {
    await this.seed();
    const at = date ?? this.today();
    const version = await this.taxes
      .findOne({ code: code.toUpperCase(), effectiveFrom: { $lte: at } })
      .sort({ effectiveFrom: -1 })
      .exec();
    if (!version) {
      throw new NotFoundException(
        `No hay impuesto '${code}' vigente al ${at}`,
      );
    }
    return version;
  }

  /** Calcula el impuesto de una base (COP entero) con la tarifa vigente. */
  async compute(
    code: string,
    base: number,
    date?: string,
  ): Promise<TaxComputation> {
    const version = await this.resolveRate(code, date);
    if (version.basis === 'por_unidad') {
      throw new BadRequestException(
        `'${version.code}' es un valor fijo por unidad, no un porcentaje de una base`,
      );
    }
    const safeBase = Math.max(0, cop(base));
    const taxAmount = cop((safeBase * version.rate) / 100);
    return {
      code: version.code,
      kind: version.kind,
      base: safeBase,
      rate: version.rate,
      taxAmount,
      total: safeBase + taxAmount,
      date: date ?? this.today(),
    };
  }

  /**
   * INC por bolsa plástica vigente a la fecha (art. 512-15 ET), en pesos. Es 0
   * si la empresa no lo ha activado: nace inactivo y nadie lo cobra sin
   * decidirlo.
   */
  async bagTaxPerUnit(date?: string): Promise<number> {
    try {
      const version = await this.resolveRate(INC_BOLSAS_CODE, date);
      return version.active ? cop(version.rate) : 0;
    } catch (err) {
      if (err instanceof NotFoundException) return 0;
      throw err;
    }
  }

  async create(dto: CreateTaxDto, userEmail?: string): Promise<TaxView> {
    await this.seed();
    const code = dto.code.toUpperCase();
    const exists = await this.taxes.exists({ code }).exec();
    if (exists) throw new BadRequestException(`El código '${code}' ya existe`);
    await this.taxes.create({
      code,
      name: dto.name,
      kind: dto.kind,
      rate: dto.rate,
      effectiveFrom: dto.effectiveFrom,
      note: dto.note,
      active: true,
      system: false,
      createdByEmail: userEmail,
    });
    return this.getOne(code);
  }

  async setVersion(
    code: string,
    dto: SetTaxRateVersionDto,
    userEmail?: string,
  ): Promise<TaxView> {
    await this.seed();
    const upper = code.toUpperCase();
    const head = await this.taxes
      .findOne({ code: upper })
      .sort({ effectiveFrom: -1 })
      .exec();
    if (!head) throw new NotFoundException(`No existe el impuesto '${code}'`);
    const clash = await this.taxes
      .exists({ code: upper, effectiveFrom: dto.effectiveFrom })
      .exec();
    if (clash) {
      throw new BadRequestException(
        `Ya hay una vigencia de '${upper}' que arranca el ${dto.effectiveFrom}`,
      );
    }
    await this.taxes.create({
      code: upper,
      name: head.name,
      kind: head.kind,
      rate: dto.rate,
      basis: head.basis ?? 'porcentaje',
      effectiveFrom: dto.effectiveFrom,
      note: dto.note,
      active: head.active,
      system: head.system,
      createdByEmail: userEmail,
    });
    return this.getOne(upper);
  }

  /** Actualiza metadatos (nombre/activo) de todas las vigencias de un código. */
  async update(code: string, dto: UpdateTaxDto): Promise<TaxView> {
    const upper = code.toUpperCase();
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.active !== undefined) set.active = dto.active;
    if (Object.keys(set).length === 0) return this.getOne(upper);
    const res = await this.taxes.updateMany({ code: upper }, { $set: set }).exec();
    if (res.matchedCount === 0) {
      throw new NotFoundException(`No existe el impuesto '${code}'`);
    }
    return this.getOne(upper);
  }

  private async getOne(code: string): Promise<TaxView> {
    const all = await this.list();
    const found = all.find((v) => v.code === code.toUpperCase());
    if (!found) throw new NotFoundException(`No existe el impuesto '${code}'`);
    return found;
  }
}
