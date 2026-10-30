import { describe, it, expect, vi } from 'vitest';

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
import { SEED_TAXES } from '../domain/tax.constants';

/** Tarifa de INC_BOLSA que ve el POS: la misma que cobra la venta. */
describe('TaxService · incBolsasVigente', () => {
  function servicio(versiones: Array<Record<string, unknown>>) {
    const taxes = {
      distinct: () => ({ exec: () => Promise.resolve(SEED_TAXES.map((t) => t.code)) }),
      insertMany: vi.fn(),
      findOne: (filter: { effectiveFrom: { $lte: string } }) => ({
        sort: () => ({
          exec: () =>
            Promise.resolve(
              versiones
                .filter((v) => (v.effectiveFrom as string) <= filter.effectiveFrom.$lte)
                .sort((a, b) => (b.effectiveFrom as string).localeCompare(a.effectiveFrom as string))[0] ??
                null,
            ),
        }),
      }),
    };
    return new TaxService(taxes as never);
  }
  const v = (over: Record<string, unknown>) => ({
    code: 'INC_BOLSA',
    kind: 'inc',
    basis: 'por_unidad',
    ...over,
  });

  it('activo: devuelve tarifa y vigencia a la fecha pedida', async () => {
    const s = servicio([
      v({ rate: 66, effectiveFrom: '2026-01-01', active: true }),
      v({ rate: 70, effectiveFrom: '2027-01-01', active: true }),
    ]);
    expect(await s.incBolsasVigente('2026-06-01')).toEqual({
      activo: true,
      tarifa: 66,
      vigenteDesde: '2026-01-01',
    });
    expect((await s.incBolsasVigente('2027-02-01')).tarifa).toBe(70);
  });

  it('inactivo: tarifa 0, sin vigencia', async () => {
    const s = servicio([v({ rate: 66, effectiveFrom: '2026-01-01', active: false })]);
    expect(await s.incBolsasVigente('2026-06-01')).toEqual({
      activo: false,
      tarifa: 0,
      vigenteDesde: null,
    });
  });

  it('sin vigencia anterior a la fecha: inactivo, no falla', async () => {
    const s = servicio([v({ rate: 66, effectiveFrom: '2026-01-01', active: true })]);
    expect((await s.incBolsasVigente('2020-01-01')).activo).toBe(false);
  });
});
