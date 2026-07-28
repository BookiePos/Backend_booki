import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Parameter,
  ParameterDocument,
} from '../infrastructure/schemas/parameter.schema';
import { SEED_PARAMS } from '../domain/params.constants';
import {
  CreateParameterDto,
  SetParameterVersionDto,
} from './dto/parameter.dto';

/** Vista de una clave con su valor vigente y su histórico de vigencias. */
export interface ParameterView {
  key: string;
  label: string;
  group: string;
  valueType: string;
  unit?: string;
  system: boolean;
  current: {
    value: number | string | boolean;
    effectiveFrom: string;
    note?: string;
  } | null;
  history: {
    value: number | string | boolean;
    effectiveFrom: string;
    note?: string;
    createdByEmail?: string;
    upcoming: boolean;
  }[];
}

@Injectable()
export class ParamsService {
  constructor(
    @InjectModel(Parameter.name)
    private readonly params: Model<ParameterDocument>,
  ) {}

  private today(): string {
    return new Date().toLocaleDateString('en-CA');
  }

  /** Siembra la primera versión de cada parámetro base (idempotente). */
  private async seed(): Promise<void> {
    const existing = await this.params.countDocuments({ system: true }).exec();
    if (existing > 0) return;
    await this.params.insertMany(
      SEED_PARAMS.map((p) => ({
        key: p.key,
        label: p.label,
        group: p.group,
        valueType: p.valueType,
        value: p.value,
        unit: p.unit,
        note: p.note,
        effectiveFrom: '2026-01-01',
        system: true,
      })),
    );
  }

  /** Agrupa las versiones por clave y resuelve la vigente a hoy. */
  async list(): Promise<ParameterView[]> {
    await this.seed();
    const docs = await this.params
      .find()
      .sort({ key: 1, effectiveFrom: -1 })
      .exec();
    const today = this.today();
    const byKey = new Map<string, ParameterDocument[]>();
    for (const d of docs) {
      const arr = byKey.get(d.key) ?? [];
      arr.push(d);
      byKey.set(d.key, arr);
    }
    const views: ParameterView[] = [];
    for (const [key, versions] of byKey) {
      // versions ya viene ordenado por effectiveFrom desc.
      const head = versions[0];
      if (!head) continue;
      const current = versions.find((v) => v.effectiveFrom <= today) ?? null;
      views.push({
        key,
        label: head.label,
        group: head.group,
        valueType: head.valueType,
        unit: head.unit,
        system: head.system,
        current: current
          ? {
              value: current.value,
              effectiveFrom: current.effectiveFrom,
              note: current.note,
            }
          : null,
        history: versions.map((v) => ({
          value: v.value,
          effectiveFrom: v.effectiveFrom,
          note: v.note,
          createdByEmail: v.createdByEmail,
          upcoming: v.effectiveFrom > today,
        })),
      });
    }
    return views.sort((a, b) =>
      a.group === b.group
        ? a.key.localeCompare(b.key)
        : a.group.localeCompare(b.group),
    );
  }

  /** Resuelve el valor vigente de una clave a una fecha (por defecto hoy). */
  async resolve(
    key: string,
    date?: string,
  ): Promise<{ key: string; value: number | string | boolean; effectiveFrom: string }> {
    await this.seed();
    const at = date ?? this.today();
    const version = await this.params
      .findOne({ key, effectiveFrom: { $lte: at } })
      .sort({ effectiveFrom: -1 })
      .exec();
    if (!version) {
      throw new NotFoundException(
        `No hay parámetro '${key}' vigente al ${at}`,
      );
    }
    return {
      key,
      value: version.value,
      effectiveFrom: version.effectiveFrom,
    };
  }

  async create(
    dto: CreateParameterDto,
    userEmail?: string,
  ): Promise<ParameterView> {
    await this.seed();
    const exists = await this.params.exists({ key: dto.key }).exec();
    if (exists) {
      throw new BadRequestException(`La clave '${dto.key}' ya existe`);
    }
    await this.params.create({
      key: dto.key,
      label: dto.label,
      group: dto.group,
      valueType: dto.valueType,
      value: dto.value,
      unit: dto.unit,
      note: dto.note,
      effectiveFrom: dto.effectiveFrom,
      system: false,
      createdByEmail: userEmail,
    });
    return this.getOne(dto.key);
  }

  /** Abre una vigencia nueva de una clave existente (no edita el histórico). */
  async setVersion(
    key: string,
    dto: SetParameterVersionDto,
    userEmail?: string,
  ): Promise<ParameterView> {
    await this.seed();
    const head = await this.params
      .findOne({ key })
      .sort({ effectiveFrom: -1 })
      .exec();
    if (!head) throw new NotFoundException(`No existe el parámetro '${key}'`);
    const clash = await this.params
      .exists({ key, effectiveFrom: dto.effectiveFrom })
      .exec();
    if (clash) {
      throw new BadRequestException(
        `Ya hay una vigencia de '${key}' que arranca el ${dto.effectiveFrom}`,
      );
    }
    await this.params.create({
      key,
      label: head.label,
      group: head.group,
      valueType: head.valueType,
      value: dto.value,
      unit: head.unit,
      note: dto.note,
      effectiveFrom: dto.effectiveFrom,
      system: head.system,
      createdByEmail: userEmail,
    });
    return this.getOne(key);
  }

  private async getOne(key: string): Promise<ParameterView> {
    const all = await this.list();
    const found = all.find((v) => v.key === key);
    if (!found) throw new NotFoundException(`No existe el parámetro '${key}'`);
    return found;
  }
}
