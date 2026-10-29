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
 * Asiento de la venta con domicilio (impuesto incluido) y con INC de bolsas.
 *
 * - La base del domicilio va a Ingresos (4135) y su impuesto a la 2495 (INC) o
 *   a la 2408 (IVA), igual que el de la comida (arts. 512-1 num. 3 y 512-9 ET,
 *   Oficio DIAN 664 de 2022).
 * - El INC de bolsas (art. 512-15) va a su subcuenta 249510: otro renglón del
 *   formulario 310, que así sale sin separarlo del INC del 8 %.
 */
describe('LedgerPostingService.postSale · domicilio con impuesto y bolsas', () => {
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  const base = {
    saleId: 's1',
    number: 'FV-000001',
    date: '2026-10-29',
    sedeId: SEDE,
    paymentMethod: 'cash',
    cogs: 0,
  };

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
    };
    service = new LedgerPostingService(ledger as never, { registrar: vi.fn() } as never);
  });

  it('domicilio con INC: base a 4135, INC a la 2495 junto con el de la comida', async () => {
    await service.postSale({
      ...base,
      total: 30_000,
      tax: 0,
      consumptionTax: 2_222,
      deliveryFee: 5_000,
      deliveryTax: { kind: 'inc', amount: 370 },
    });

    expect(side('debit')).toBe(side('credit'));
    // En el arqueo y en Caja entra lo mismo de siempre: total + domicilio.
    expect(on(ACC.CAJA, 'debit')).toBe(35_000);
    expect(on(ACC.INC_POR_PAGAR, 'credit')).toBe(2_592);
    expect(on(ACC.INGRESOS_VENTAS, 'credit')).toBe(27_778 + 4_630);
    expect(on(ACC.IVA_POR_PAGAR, 'credit')).toBe(0);
  });

  it('franquicia: el IVA del domicilio va a la 2408', async () => {
    await service.postSale({
      ...base,
      total: 11_900,
      tax: 1_900,
      deliveryFee: 5_000,
      deliveryTax: { kind: 'iva', amount: 798 },
    });

    expect(side('debit')).toBe(side('credit'));
    expect(on(ACC.IVA_POR_PAGAR, 'credit')).toBe(2_698);
    expect(on(ACC.INC_POR_PAGAR, 'credit')).toBe(0);
    expect(on(ACC.INGRESOS_VENTAS, 'credit')).toBe(10_000 + 4_202);
  });

  it('sin impuesto del domicilio (no responsable o venta vieja): entra entero a ingresos', async () => {
    await service.postSale({ ...base, total: 30_000, tax: 0, deliveryFee: 5_000 });
    expect(side('debit')).toBe(side('credit'));
    expect(on(ACC.INGRESOS_VENTAS, 'credit')).toBe(35_000);
  });

  it('INC de bolsas: sale de ingresos y va a la 249510', async () => {
    await service.postSale({
      ...base,
      total: 30_146,
      tax: 0,
      consumptionTax: 2_222,
      bagTax: 146,
    });

    expect(side('debit')).toBe(side('credit'));
    expect(on(ACC.INC_BOLSAS_POR_PAGAR, 'credit')).toBe(146);
    expect(on(ACC.INC_POR_PAGAR, 'credit')).toBe(2_222);
    expect(on(ACC.INGRESOS_VENTAS, 'credit')).toBe(27_778);
  });

  it('la 249510 está en el plan de cuentas que se siembra a cada empresa', () => {
    expect(ACC.INC_BOLSAS_POR_PAGAR).toBe('249510');
    expect(SEED_ACCOUNTS.find((a) => a.code === '249510')?.type).toBe('liability');
  });
});
