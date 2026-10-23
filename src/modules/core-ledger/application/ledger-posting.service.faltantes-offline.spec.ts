import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { LedgerPostingService } from './ledger-posting.service';
import { ACC, SEED_ACCOUNTS } from '../domain/ledger.constants';
import type { PostLine } from './ledger.service';

/**
 * Ítem 6.3: lo vendido sin conexión que no estaba en el inventario registrado
 * se costea al último costo contra la puente 143595, y al regularizar se
 * cierra la puente contra 1435 por el costo real.
 */
describe('LedgerPostingService · faltantes de ventas offline', () => {
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  let ledger: any;
  let service: LedgerPostingService;

  const lines = (): PostLine[] => ledger.post.mock.calls.at(-1)?.[0].lines ?? [];
  const side = (w: 'debit' | 'credit') => lines().reduce((s, l) => s + (l[w] ?? 0), 0);
  const on = (code: string, w: 'debit' | 'credit') =>
    lines().filter((l) => l.accountCode === code).reduce((s, l) => s + (l[w] ?? 0), 0);

  beforeEach(() => {
    ledger = {
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockResolvedValue({}),
    };
    service = new LedgerPostingService(ledger as never, { registrar: vi.fn() } as never);
  });

  it('la cuenta puente existe en el plan sembrado', () => {
    expect(SEED_ACCOUNTS.some((a) => a.code === ACC.INVENTARIO_POR_REGULARIZAR)).toBe(true);
  });

  it('la venta lleva el costo del faltante a 6135 contra la puente y cuadra', async () => {
    await service.postSale({
      saleId: 's1',
      number: 'FVC-000001',
      date: '2026-10-22',
      sedeId: SEDE,
      total: 23_800,
      tax: 0,
      cogs: 4_000,
      faltanteCost: 4_000,
      paymentMethod: 'cash',
    });
    expect(on(ACC.COSTO_VENTA, 'debit')).toBe(8_000);
    expect(on(ACC.INVENTARIO, 'credit')).toBe(4_000);
    expect(on(ACC.INVENTARIO_POR_REGULARIZAR, 'credit')).toBe(4_000);
    expect(side('debit')).toBe(side('credit'));
  });

  it('regularizar con costo real mayor: la diferencia va a 6135 débito', async () => {
    await service.postRegularizacionFaltante({
      saleId: 's1',
      number: 'FVC-000001',
      date: '2026-10-23',
      sedeId: SEDE,
      estimado: 4_000,
      real: 4_500,
    });
    expect(ledger.post.mock.calls[0][0].sourceType).toBe('offline_faltante');
    expect(on(ACC.INVENTARIO_POR_REGULARIZAR, 'debit')).toBe(4_000);
    expect(on(ACC.INVENTARIO, 'credit')).toBe(4_500);
    expect(on(ACC.COSTO_VENTA, 'debit')).toBe(500);
    expect(side('debit')).toBe(side('credit'));
  });

  it('regularizar con costo real menor: la diferencia va a 6135 crédito', async () => {
    await service.postRegularizacionFaltante({
      saleId: 's1',
      number: 'FVC-000001',
      date: '2026-10-23',
      sedeId: SEDE,
      estimado: 4_000,
      real: 3_000,
    });
    expect(on(ACC.COSTO_VENTA, 'credit')).toBe(1_000);
    expect(side('debit')).toBe(side('credit'));
  });

  it('sin costo estimado ni real no hay asiento', async () => {
    const ok = await service.postRegularizacionFaltante({
      saleId: 's1',
      number: 'FVC-000001',
      date: '2026-10-23',
      sedeId: SEDE,
      estimado: 0,
      real: 0,
    });
    expect(ok).toBe(true);
    expect(ledger.post).not.toHaveBeenCalled();
  });
});
