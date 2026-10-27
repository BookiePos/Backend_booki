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
 * Ítem 6.4: datáfono y billeteras entran a Bancos (1110) con la venta, nunca a
 * Caja, y la conciliación asienta comisión, IVA y retenciones contra Bancos.
 */
describe('LedgerPostingService · pagos digitales (6.4)', () => {
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  let ledger: any;
  let service: LedgerPostingService;

  const lines = (): PostLine[] => ledger.post.mock.calls.at(-1)?.[0].lines ?? [];
  const side = (w: 'debit' | 'credit') => lines().reduce((a, l) => a + (l[w] ?? 0), 0);
  const on = (code: string, w: 'debit' | 'credit') =>
    lines()
      .filter((l) => l.accountCode === code)
      .reduce((a, l) => a + (l[w] ?? 0), 0);

  beforeEach(() => {
    ledger = {
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockResolvedValue({}),
      reverseBySource: vi.fn().mockResolvedValue({}),
    };
    service = new LedgerPostingService(ledger as never, { registrar: vi.fn() } as never);
  });

  it('las cuentas nuevas existen en el plan sembrado', () => {
    for (const code of [
      ACC.COMISIONES_FINANCIERAS,
      ACC.RETEFUENTE_A_FAVOR,
      ACC.RETEICA_A_FAVOR,
      ACC.RETEIVA_A_FAVOR,
    ]) {
      expect(SEED_ACCOUNTS.some((a) => a.code === code)).toBe(true);
    }
  });

  it('venta con efectivo + datáfono + Nequi + QR: Caja solo por el efectivo y cuadra', async () => {
    await service.postSale({
      saleId: 's1',
      number: 'FV-000001',
      date: '2026-10-22',
      sedeId: SEDE,
      total: 119_000,
      tax: 19_000,
      cogs: 40_000,
      deliveryFee: 5_000,
      tip: 6_000,
      payments: [
        { method: 'cash', amount: 30_000 },
        { method: 'card', amount: 50_000 },
        { method: 'transfer', amount: 30_000 },
        { method: 'transfer', amount: 20_000 },
      ],
    });
    expect(side('debit')).toBe(side('credit'));
    expect(on(ACC.CAJA, 'debit')).toBe(30_000);
    expect(on(ACC.BANCOS, 'debit')).toBe(100_000);
    expect(on(ACC.PROPINAS_POR_PAGAR, 'credit')).toBe(6_000);
  });

  describe('conciliación', () => {
    const base = { settlementId: 'c1', label: 'Datáfono visa 2026-10-20', date: '2026-10-22', sedeId: SEDE };

    it('comisión + retenciones salen de Bancos y el asiento cuadra', async () => {
      await service.postPaymentSettlement({
        ...base,
        commission: 3_000,
        commissionIva: 570,
        ivaDescontable: true,
        retefuente: 1_000,
        reteIca: 300,
        reteIva: 130,
      });
      expect(side('debit')).toBe(side('credit'));
      expect(on(ACC.COMISIONES_FINANCIERAS, 'debit')).toBe(3_000);
      expect(on(ACC.IVA_POR_PAGAR, 'debit')).toBe(570);
      expect(on(ACC.RETEFUENTE_A_FAVOR, 'debit')).toBe(1_000);
      expect(on(ACC.RETEICA_A_FAVOR, 'debit')).toBe(300);
      expect(on(ACC.RETEIVA_A_FAVOR, 'debit')).toBe(130);
      expect(on(ACC.BANCOS, 'credit')).toBe(5_000);
      expect(on(ACC.CAJA, 'debit') + on(ACC.CAJA, 'credit')).toBe(0);
    });

    it('IVA no descontable: va como mayor valor del gasto', async () => {
      await service.postPaymentSettlement({
        ...base,
        commission: 3_000,
        commissionIva: 570,
        ivaDescontable: false,
      });
      expect(on(ACC.IVA_POR_PAGAR, 'debit')).toBe(0);
      expect(on(ACC.COMISIONES_FINANCIERAS, 'debit')).toBe(3_570);
      expect(side('debit')).toBe(side('credit'));
    });

    it('sin descuentos no postea nada', async () => {
      await service.postPaymentSettlement({ ...base, commission: 0 });
      expect(ledger.post).not.toHaveBeenCalled();
    });

    it('se reversa con el contra-asiento de su origen', async () => {
      ledger.findBySource.mockResolvedValue({ _id: 'x' });
      await service.reversePaymentSettlement('c1', 'a@b.co');
      expect(ledger.reverseBySource).toHaveBeenCalled();
    });
  });
});
