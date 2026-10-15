import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

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

import { LedgerService } from './ledger.service';

/**
 * `sedeIds` empuja a Mongo el alcance por sede (checklist 3.3): «todos los
 * renglones en mis sedes». Antes el controller traía los 1000 más recientes de
 * la empresa y filtraba en memoria, y una sede tranquila veía la lista vacía.
 */
describe('LedgerService · listEntries con sedeIds', () => {
  const S1 = '64b000000000000000000001';
  const S2 = '64b000000000000000000002';

  let entries: any;
  let chain: { sort: any; limit: any; exec: any };
  let service: LedgerService;

  beforeEach(() => {
    chain = {
      sort: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      exec: vi.fn(async () => [{ _id: 'e1' }]),
    };
    entries = { find: vi.fn(() => chain) };
    service = new LedgerService({} as never, entries as never, { findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({ seq: 1 }) })) } as never);
  });

  it('construye el filtro: hay renglones y ninguno cae fuera de las sedes (o sin sede)', async () => {
    await service.listEntries({ sedeIds: [S1, S2] });
    const filter = entries.find.mock.calls[0][0];
    expect(filter['lines.0']).toEqual({ $exists: true });
    const elem = filter.lines.$not.$elemMatch.sedeId.$nin;
    expect(elem).toHaveLength(2);
    expect(elem.every((id: unknown) => id instanceof Types.ObjectId)).toBe(true);
    expect(elem.map(String)).toEqual([S1, S2]);
  });

  it('se combina con los demás filtros y no impone el tope de 1000 por sí mismo', async () => {
    await service.listEntries({
      sedeIds: [S1],
      sourceType: 'sale',
      accountCode: '1105',
      from: '2026-01-01',
      limit: 50,
    });
    const filter = entries.find.mock.calls[0][0];
    expect(filter.sourceType).toBe('sale');
    expect(filter['lines.accountCode']).toBe('1105');
    expect(filter.date).toEqual({ $gte: '2026-01-01' });
    expect(filter['lines.0']).toEqual({ $exists: true });
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it('lista de sedes vacía: [] sin consultar', async () => {
    expect(await service.listEntries({ sedeIds: [] })).toEqual([]);
    expect(entries.find).not.toHaveBeenCalled();
  });

  it('ids que no son ObjectId se descartan; si no queda ninguno, [] sin consultar', async () => {
    expect(await service.listEntries({ sedeIds: ['zzz'] })).toEqual([]);
    expect(entries.find).not.toHaveBeenCalled();
    await service.listEntries({ sedeIds: ['zzz', S1] });
    const nin = entries.find.mock.calls[0][0].lines.$not.$elemMatch.sedeId.$nin;
    expect(nin.map(String)).toEqual([S1]);
  });

  it('sin sedeIds el filtro no toca los renglones (dueño: empresa entera)', async () => {
    await service.listEntries({});
    const filter = entries.find.mock.calls[0][0];
    expect(filter.lines).toBeUndefined();
    expect(filter['lines.0']).toBeUndefined();
  });
});
