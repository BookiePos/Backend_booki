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

/** Opciones de resolución de un parámetro (fecha de vigencia y sede). */
export interface ResolveOpts {
  /** Fecha (YYYY-MM-DD) a la que resolver la vigencia; por defecto hoy. */
  date?: string;
  /** Sede para preferir un override; cae a la global si no existe. */
  sedeId?: string;
}

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
   * Descarta una sola vez el índice único legacy `key_1_effectiveFrom_1` (sin
   * `sedeId`), que impediría crear overrides por sede. Idempotente y tolerante:
   * si la colección es nueva o el índice no existe, no hace nada.
   */
  private schemaEnsured = false;
  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    this.schemaEnsured = true;
    try {
      const indexes = await this.params.collection.indexes();
      if (indexes.some((i) => i.name === 'key_1_effectiveFrom_1')) {
        await this.params.collection.dropIndex('key_1_effectiveFrom_1');
      }
    } catch {
      // Colección aún sin crear o índice ausente: nada que migrar.
    }
  }

  /**
   * Siembra los parámetros base que falten (idempotente e incremental): inserta
   * solo las claves de sistema que aún no existen, sin tocar el histórico ni las
   * versiones ya publicadas. Así, al añadir parámetros nuevos al catálogo, las
   * empresas ya sembradas los reciben en la siguiente consulta.
   */
  private async seed(): Promise<void> {
    await this.ensureSchema();
    const existingKeys = new Set(
      (await this.params.distinct('key', { system: true })) as string[],
    );
    const missing = SEED_PARAMS.filter((p) => !existingKeys.has(p.key));
    if (missing.length === 0) return;
    await this.params.insertMany(
      missing.map((p) => ({
        key: p.key,
        label: p.label,
        group: p.group,
        valueType: p.valueType,
        value: p.value,
        unit: p.unit,
        note: p.note,
        effectiveFrom: '2026-01-01',
        sedeId: null,
        system: true,
      })),
    );
  }

  /**
   * Agrupa las versiones por clave y resuelve la vigente a hoy. Muestra solo los
   * parámetros GLOBALES (sin `sedeId`); los overrides por sede se gestionan/
   * consultan aparte y no ensucian la pantalla de configuración general.
   */
  async list(): Promise<ParameterView[]> {
    await this.seed();
    const docs = await this.params
      .find({ $or: [{ sedeId: null }, { sedeId: { $exists: false } }] })
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

  /**
   * Resuelve el valor vigente de una clave a una fecha (por defecto hoy). Si se
   * pasa `sedeId`, prefiere la versión de esa sede y, si no existe, cae a la
   * global. Lanza si no hay ninguna versión aplicable.
   */
  async resolve(
    key: string,
    opts?: ResolveOpts,
  ): Promise<{
    key: string;
    value: number | string | boolean;
    effectiveFrom: string;
    sedeId: string | null;
  }> {
    await this.seed();
    const at = opts?.date ?? this.today();
    // Override por sede primero (si se pidió), luego el global.
    const scopes: (string | null)[] = opts?.sedeId
      ? [opts.sedeId, null]
      : [null];
    for (const scope of scopes) {
      const version = await this.params
        .findOne({
          key,
          effectiveFrom: { $lte: at },
          ...(scope === null
            ? { $or: [{ sedeId: null }, { sedeId: { $exists: false } }] }
            : { sedeId: scope }),
        })
        .sort({ effectiveFrom: -1 })
        .exec();
      if (version) {
        return {
          key,
          value: version.value,
          effectiveFrom: version.effectiveFrom,
          sedeId: version.sedeId ?? null,
        };
      }
    }
    throw new NotFoundException(`No hay parámetro '${key}' vigente al ${at}`);
  }

  /**
   * Igual que `resolve` pero NO lanza: devuelve el valor vigente o `null` si la
   * clave no existe o aún no está sembrada. Pensado para consumidores que deben
   * degradar con un valor por defecto en vez de romper el flujo.
   */
  async resolveValue(
    key: string,
    opts?: ResolveOpts,
  ): Promise<number | string | boolean | null> {
    try {
      return (await this.resolve(key, opts)).value;
    } catch {
      return null;
    }
  }

  /** Resuelve una clave numérica (number/percent/money) con valor por defecto. */
  async number(key: string, fallback: number, opts?: ResolveOpts): Promise<number> {
    const v = await this.resolveValue(key, opts);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  /** Resuelve una clave booleana con valor por defecto. */
  async bool(key: string, fallback: boolean, opts?: ResolveOpts): Promise<boolean> {
    const v = await this.resolveValue(key, opts);
    return typeof v === 'boolean' ? v : fallback;
  }

  /** Resuelve una clave de texto con valor por defecto. */
  async text(key: string, fallback: string, opts?: ResolveOpts): Promise<string> {
    const v = await this.resolveValue(key, opts);
    return typeof v === 'string' && v.length > 0 ? v : fallback;
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
