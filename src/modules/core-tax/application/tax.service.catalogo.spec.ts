import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import { TaxService } from './tax.service';
import { TaxController } from '../infrastructure/tax.controller';
import { CreateTaxDto, SetTaxRateVersionDto, UpdateTaxDto } from './dto/tax.dto';
import { SEED_TAXES } from '../domain/tax.constants';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

interface Fila {
  code: string;
  name: string;
  kind: string;
  rate: number;
  effectiveFrom: string;
  note?: string;
  active: boolean;
  system: boolean;
}

/**
 * Modelo en memoria con lo que usa TaxService: filtros por código y por
 * `effectiveFrom <= fecha`, y orden por código y vigencia descendente.
 */
function modeloEnMemoria(filas: Fila[]) {
  const cumple = (f: Fila, filtro: Record<string, any>) =>
    Object.entries(filtro).every(([k, v]) =>
      v && typeof v === 'object' && '$lte' in v
        ? (f as any)[k] <= v.$lte
        : (f as any)[k] === v,
    );
  const ordenadas = (xs: Fila[]) =>
    [...xs].sort((a, b) =>
      a.code === b.code ? b.effectiveFrom.localeCompare(a.effectiveFrom) : a.code.localeCompare(b.code),
    );
  return {
    filas,
    countDocuments: (f: Record<string, unknown>) => ({
      exec: async () => filas.filter((x) => cumple(x, f)).length,
    }),
    insertMany: async (docs: Fila[]) => filas.push(...docs),
    find: () => ({ sort: () => ({ exec: async () => ordenadas(filas) }) }),
    findOne: (f: Record<string, unknown>) => ({
      sort: () => ({ exec: async () => ordenadas(filas.filter((x) => cumple(x, f)))[0] ?? null }),
    }),
    exists: (f: Record<string, unknown>) => ({
      exec: async () => (filas.some((x) => cumple(x, f)) ? { _id: 'x' } : null),
    }),
    create: async (doc: Fila) => {
      filas.push(doc);
      return doc;
    },
    updateMany: (f: Record<string, unknown>, u: { $set: Partial<Fila> }) => ({
      exec: async () => {
        const hits = filas.filter((x) => cumple(x, f));
        hits.forEach((x) => Object.assign(x, u.$set));
        return { matchedCount: hits.length };
      },
    }),
  };
}

/**
 * Ítem 5.3: el catálogo de impuestos. Las tarifas se versionan por fecha y el
 * cálculo redondea a peso; una tarifa futura no se aplica antes de su día.
 */
describe('TaxService · catálogo de impuestos', () => {
  let modelo: ReturnType<typeof modeloEnMemoria>;
  let service: TaxService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T15:00:00Z'));
    modelo = modeloEnMemoria([]);
    service = new TaxService(modelo as never);
  });
  afterEach(() => vi.useRealTimers());

  it('la primera consulta siembra los impuestos de ley una sola vez', async () => {
    const lista = await service.list();
    expect(lista.map((t) => t.code)).toEqual(SEED_TAXES.map((t) => t.code).sort());
    await service.list();
    expect(modelo.filas).toHaveLength(SEED_TAXES.length);
  });

  it('una tarifa futura aparece como próxima y no cambia la vigente', async () => {
    await service.list();
    const iva = SEED_TAXES.find((t) => t.kind === 'iva')!;
    const vista = await service.setVersion(iva.code.toLowerCase(), {
      rate: 21,
      effectiveFrom: '2027-01-01',
    });
    expect(vista.currentRate).toBe(iva.rate);
    expect(vista.history[0]).toMatchObject({ rate: 21, upcoming: true });
    expect((await service.compute(iva.code, 100_000, '2027-02-01')).rate).toBe(21);
  });

  it('calcula sobre COP entero y nunca sobre una base negativa', async () => {
    await service.list();
    const c = await service.compute('IVA_19', 10_001);
    expect(c).toMatchObject({ base: 10_001, taxAmount: 1900, total: 11_901, date: '2026-10-15' });
    expect((await service.compute('IVA_19', -500)).total).toBe(0);
    await expect(service.compute('NOEXISTE', 100)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('crea un impuesto propio y no deja repetir el código', async () => {
    const dto = { code: 'ICA_BOG', name: 'ICA Bogotá', kind: 'inc', rate: 1, effectiveFrom: '2026-01-01' };
    const v = await service.create(dto as never, 'dueno@x.co');
    expect(v).toMatchObject({ code: 'ICA_BOG', system: false, currentRate: 1 });
    await expect(service.create(dto as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una vigencia nueva exige que exista el impuesto y no choca con otra del mismo día', async () => {
    await service.list();
    await expect(
      service.setVersion('NADA', { rate: 5, effectiveFrom: '2027-01-01' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.setVersion('IVA_19', { rate: 5, effectiveFrom: '2026-01-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('editar cambia nombre o estado en todas las vigencias', async () => {
    await service.list();
    await service.setVersion('IVA_19', { rate: 21, effectiveFrom: '2027-01-01' });
    const v = await service.update('iva_19', { active: false, name: 'IVA general' });
    expect(v).toMatchObject({ active: false, name: 'IVA general' });
    expect(modelo.filas.filter((f) => f.code === 'IVA_19').every((f) => !f.active)).toBe(true);
    expect((await service.update('IVA_19', {})).code).toBe('IVA_19');
    await expect(service.update('NADA', { active: true })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el controlador pasa la base como entero y el correo de quien edita', async () => {
    const c = new TaxController(service);
    const user = { email: 'dueno@x.co' } as JwtUser;
    expect((await c.list()).length).toBe(SEED_TAXES.length);
    expect((await c.compute('IVA_19', 'abc')).base).toBe(0);
    await c.create({ code: 'X1', name: 'X', kind: 'inc', rate: 2, effectiveFrom: '2026-01-01' } as never, user);
    await c.setVersion('X1', { rate: 3, effectiveFrom: '2026-06-01' }, user);
    expect((await c.update('X1', { name: 'Y' })).currentRate).toBe(3);
  });
});

describe('DTO de impuestos', () => {
  const props = <T extends object>(clase: new () => T, datos: object) =>
    validateSync(plainToInstance(clase, datos)).map((e) => e.property);

  it('la tarifa va de 0 a 100 y la vigencia es una fecha', () => {
    expect(props(SetTaxRateVersionDto, { rate: 19, effectiveFrom: '2027-01-01' })).toEqual([]);
    expect(props(SetTaxRateVersionDto, { rate: 120, effectiveFrom: '1/1/27' })).toEqual([
      'rate',
      'effectiveFrom',
    ]);
  });

  it('el código va en mayúsculas y el tipo es conocido', () => {
    expect(
      props(CreateTaxDto, { code: 'ica', name: 'x', kind: 'raro', rate: 1, effectiveFrom: '2026-01-01' }),
    ).toEqual(['code', 'kind']);
    expect(props(UpdateTaxDto, { active: 'si' })).toEqual(['active']);
  });
});
