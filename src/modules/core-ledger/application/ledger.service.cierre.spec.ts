import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';

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
import { ACC, SEED_ACCOUNTS } from '../domain/ledger.constants';
import { ORIGEN_CIERRE, ORIGEN_TRASLADO } from '../domain/cierre-anual';

/**
 * Guardas del libro alrededor del cierre anual (R4, revisión 1.16): un año
 * cerrado no recibe asientos manuales ni reversas con su fecha, y los asientos
 * del cierre solo se deshacen desde «Reabrir el año».
 */
describe('LedgerService · año cerrado', () => {
  let entries: any;
  let service: LedgerService;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T17:00:00Z'));
    const accounts = {
      find: vi.fn(() => ({
        select: () => ({
          exec: () => Promise.resolve(SEED_ACCOUNTS.map((a) => ({ code: a.code }))),
        }),
        exec: () =>
          Promise.resolve(
            [ACC.CAJA, ACC.INGRESOS_VENTAS].map((code) => ({ code, name: `Cuenta ${code}` })),
          ),
      })),
    };
    entries = {
      estimatedDocumentCount: vi.fn(() => ({ exec: () => Promise.resolve(0) })),
      create: vi.fn((doc: unknown) => Promise.resolve(doc)),
      // 2025 está cerrado: existe su asiento `cierre_anual` vivo.
      findOne: vi.fn((q: { sourceType?: string; sourceId?: string }) => ({
        exec: () =>
          Promise.resolve(
            q.sourceType === ORIGEN_CIERRE && q.sourceId === '2025' ? { _id: 'c25' } : null,
          ),
      })),
      findById: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve({ modifiedCount: 1 }) })),
      aggregate: vi.fn(() => ({ exec: () => Promise.resolve([]) })),
    };
    let seq = 0;
    const counters = {
      findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({ seq: ++seq }) })),
      create: vi.fn(() => Promise.resolve({})),
    };
    service = new LedgerService(accounts as never, entries as never, counters as never);
  });
  afterEach(() => vi.useRealTimers());

  const manual = (date: string) => ({
    date,
    memo: 'Ajuste',
    lines: [
      { accountCode: ACC.CAJA, debit: 1_000 },
      { accountCode: ACC.INGRESOS_VENTAS, credit: 1_000 },
    ],
  });

  it('anioCerrado mira el asiento de cierre vivo del año', async () => {
    expect(await service.anioCerrado(2025)).toBe(true);
    expect(await service.anioCerrado(2024)).toBe(false);
  });

  it('un asiento manual con fecha de un año cerrado es 400', async () => {
    await expect(service.postFromDto(manual('2025-12-20') as never, 'a@b.co')).rejects.toThrow(
      /2025 está cerrado/,
    );
    expect(entries.create).not.toHaveBeenCalled();
  });

  it('un asiento manual del año abierto pasa', async () => {
    await expect(service.postFromDto(manual('2026-03-01') as never, 'a@b.co')).resolves.toBeTruthy();
  });

  it('un asiento manual no puede usar el origen del cierre', async () => {
    await expect(
      service.postFromDto({ ...manual('2026-03-01'), sourceType: ORIGEN_CIERRE } as never, 'a@b.co'),
    ).rejects.toThrow(BadRequestException);
  });

  const asiento = (sourceType: string, date: string) => ({
    _id: 'as-9',
    number: 'AS-000009',
    date,
    sourceType,
    sourceId: '2025',
    lines: [
      { accountCode: ACC.CAJA, accountName: 'Caja', debit: 1_000, credit: 0 },
      { accountCode: ACC.INGRESOS_VENTAS, accountName: 'Ingresos', debit: 0, credit: 1_000 },
    ],
    totalDebit: 1_000,
    totalCredit: 1_000,
    reversalOf: null,
    reversedBy: null,
    save: vi.fn(),
  });

  it.each([ORIGEN_CIERRE, ORIGEN_TRASLADO])(
    'reversar a mano un asiento del cierre (%s) es 400',
    async (origen) => {
      entries.findById.mockReturnValue({
        exec: () => Promise.resolve(asiento(origen, '2025-12-31')),
      });
      await expect(service.reverse('as-9', 'a@b.co')).rejects.toThrow(/Reabrir el año/);
      expect(entries.create).not.toHaveBeenCalled();
    },
  );

  it('una reversa con fecha dentro del año cerrado es 400', async () => {
    entries.findById.mockReturnValue({
      exec: () => Promise.resolve(asiento('manual', '2025-11-30')),
    });
    await expect(service.reverse('as-9', 'a@b.co', '2025-12-15')).rejects.toThrow(
      /2025 está cerrado/,
    );
  });
});
