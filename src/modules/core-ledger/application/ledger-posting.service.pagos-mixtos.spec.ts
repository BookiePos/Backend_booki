import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mismo patrón que el resto de las pruebas del libro: los esquemas llegan por
// la cadena de imports y sus decoradores revientan con SWC.
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
import { ACC } from '../domain/ledger.constants';
import type { PostLine } from './ledger.service';

/**
 * Asiento de una venta con cobro mixto (ítem 6.9): cada medio va a su cuenta
 * —efectivo a Caja (1105), tarjeta y transferencia a Bancos (1110), la parte
 * fiada a Clientes (1305)— y el asiento sigue cuadrado.
 */
describe('LedgerPostingService.postSale · cobro mixto', () => {
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  let ledger: any;
  let service: LedgerPostingService;

  const lines = (): PostLine[] => ledger.post.mock.calls.at(-1)?.[0].lines ?? [];
  const side = (w: 'debit' | 'credit') => lines().reduce((a, l) => a + (l[w] ?? 0), 0);
  const on = (code: string, w: 'debit' | 'credit') =>
    lines()
      .filter((l) => l.accountCode === code)
      .reduce((a, l) => a + (l[w] ?? 0), 0);

  // Venta de $119.000 con IVA de $19.000, domicilio de $5.000 y propina de $6.000:
  // el cliente paga $130.000.
  const base = {
    saleId: 's1',
    number: 'FV-000001',
    date: '2026-10-15',
    sedeId: SEDE,
    total: 119_000,
    tax: 19_000,
    cogs: 40_000,
    deliveryFee: 5_000,
    tip: 6_000,
    paymentMethod: 'card',
  };

  beforeEach(() => {
    ledger = {
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockResolvedValue({}),
      reverseBySource: vi.fn().mockResolvedValue({}),
    };
    service = new LedgerPostingService(ledger as never, { registrar: vi.fn() } as never);
  });

  it('efectivo + tarjeta: Caja y Bancos por lo suyo, cuadrado', async () => {
    await service.postSale({
      ...base,
      payments: [
        { method: 'cash', amount: 50_000 },
        { method: 'card', amount: 80_000 },
      ],
    });
    expect(side('debit')).toBe(side('credit'));
    expect(on(ACC.CAJA, 'debit')).toBe(50_000);
    expect(on(ACC.BANCOS, 'debit')).toBe(80_000);
    expect(on(ACC.PROPINAS_POR_PAGAR, 'credit')).toBe(6_000);
    expect(on(ACC.INGRESOS_VENTAS, 'credit')).toBe(105_000);
  });

  it('tarjeta + transferencia van a Bancos en un solo renglón', async () => {
    await service.postSale({
      ...base,
      payments: [
        { method: 'transfer', amount: 30_000 },
        { method: 'card', amount: 100_000 },
      ],
    });
    expect(side('debit')).toBe(side('credit'));
    expect(lines().filter((l) => l.accountCode === ACC.BANCOS)).toHaveLength(1);
    expect(on(ACC.BANCOS, 'debit')).toBe(130_000);
  });

  it('parte fiada: Clientes por lo fiado y la propina sigue en el pasivo', async () => {
    await service.postSale({
      ...base,
      payments: [
        { method: 'credit', amount: 100_000 },
        { method: 'cash', amount: 30_000 },
      ],
    });
    expect(side('debit')).toBe(side('credit'));
    expect(on(ACC.CLIENTES, 'debit')).toBe(100_000);
    expect(on(ACC.CAJA, 'debit')).toBe(30_000);
    expect(on(ACC.PROPINAS_POR_PAGAR, 'credit')).toBe(6_000);
  });

  it('sin reparto, la venta de un solo medio queda igual que antes', async () => {
    await service.postSale(base);
    expect(side('debit')).toBe(side('credit'));
    expect(on(ACC.BANCOS, 'debit')).toBe(130_000);
    expect(on(ACC.CAJA, 'debit')).toBe(0);
  });
});
