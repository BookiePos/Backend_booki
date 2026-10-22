import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACC } from '../modules/core-ledger/domain/ledger.constants';
import { SaleSchema } from '../modules/sales/infrastructure/schemas/sale.schema';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * Pedidos de plataformas de domicilio contra un Mongo real (ítem 7.5):
 *  - el índice parcial único (plataforma, código) deja un solo pedido vivo;
 *  - venta de plataforma + liquidación + anulación dejan el libro cuadrado, la
 *    cuenta por cobrar en cero y NADA en Caja.
 */
describe('pedidos de plataforma', () => {
  const EMPRESA = 'eeeeeeeeeeeeeeeeeeeeeeee';
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  let env: Entorno;

  beforeAll(async () => {
    env = await levantarEntorno();
  });
  afterAll(async () => {
    await env?.cerrar();
  });

  const doc = (extra: Record<string, unknown>) => ({
    saleNumber: `FV-${Math.random()}`,
    sedeId: SEDE,
    total: 10_000,
    payment: { method: 'platform' },
    ...extra,
  });

  it('(plataforma, código) es único entre completadas; anulada libera el código; otras plataformas y ventas normales no chocan', async () => {
    const base = env.baseDe(EMPRESA);
    const Sale = base.model('Sale', SaleSchema);
    await Sale.init();
    const ventas = Sale.collection;

    await ventas.insertOne(
      doc({ status: 'completed', platform: { code: 'rappi', externalId: 'R-1' } }),
    );
    await expect(
      ventas.insertOne(doc({ status: 'completed', platform: { code: 'rappi', externalId: 'R-1' } })),
    ).rejects.toMatchObject({ code: 11000 });

    // Mismo código en otra plataforma: son pedidos distintos.
    await ventas.insertOne(
      doc({ status: 'completed', platform: { code: 'didi', externalId: 'R-1' } }),
    );
    // Ventas sin plataforma: ilimitadas.
    await ventas.insertOne(doc({ status: 'completed', payment: { method: 'cash' } }));
    await ventas.insertOne(doc({ status: 'completed', payment: { method: 'cash' } }));

    // Anulada: no cuenta, y se puede registrar de nuevo.
    await ventas.insertOne(
      doc({ status: 'void', platform: { code: 'uber_eats', externalId: 'U-9' } }),
    );
    await ventas.insertOne(
      doc({ status: 'completed', platform: { code: 'uber_eats', externalId: 'U-9' } }),
    );
  });

  it('venta + liquidación + anulación: cuadra, CxC en cero y Caja intacta', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      await env.posting.postSale({
        saleId: 'pl-1',
        number: 'FV-000001',
        date: '2026-10-14',
        sedeId: SEDE,
        total: 119_000,
        tax: 19_000,
        cogs: 40_000,
        deliveryFee: 6_000,
        paymentMethod: 'platform',
      });
      await env.posting.postPlatformSettlement({
        settlementId: 'liq-1',
        platformLabel: 'Rappi',
        date: '2026-10-21',
        sedeId: SEDE,
        gross: 125_000,
        received: 90_000,
        commission: 30_000,
        commissionIva: 5_000,
      });
      // Reintento: idempotente por origen.
      await env.posting.postPlatformSettlement({
        settlementId: 'liq-1',
        platformLabel: 'Rappi',
        date: '2026-10-21',
        sedeId: SEDE,
        gross: 125_000,
        received: 90_000,
        commission: 30_000,
        commissionIva: 5_000,
      });
    });

    const entradas = await env
      .baseDe(EMPRESA)
      .collection('ledger_journal_entries')
      .find({ sourceType: { $in: ['sale', 'platform_settlement'] } })
      .toArray();
    expect(entradas).toHaveLength(2);

    const saldo = (code: string, side: 'debit' | 'credit') =>
      entradas
        .flatMap((e) => e.lines as { accountCode: string; debit?: number; credit?: number }[])
        .filter((l) => l.accountCode === code)
        .reduce((a, l) => a + (l[side] ?? 0), 0);

    // Cada asiento cuadra.
    for (const e of entradas) {
      const lines = e.lines as { debit?: number; credit?: number }[];
      expect(lines.reduce((a, l) => a + (l.debit ?? 0), 0)).toBe(
        lines.reduce((a, l) => a + (l.credit ?? 0), 0),
      );
    }
    // La plataforma debía 125.000 y los pagó (consignado + comisión + IVA).
    expect(saldo(ACC.CLIENTES, 'debit')).toBe(125_000);
    expect(saldo(ACC.CLIENTES, 'credit')).toBe(125_000);
    expect(saldo(ACC.COMISIONES_PLATAFORMAS, 'debit')).toBe(30_000);
    expect(saldo(ACC.BANCOS, 'debit')).toBe(90_000);
    // No hay efectivo de por medio: no entra al arqueo.
    expect(saldo(ACC.CAJA, 'debit') + saldo(ACC.CAJA, 'credit')).toBe(0);

    // Anular la liquidación deja la CxC otra vez abierta por 125.000.
    await env.enEmpresa(EMPRESA, () => env.posting.reversePlatformSettlement('liq-1', 'a@x.co'));
    const todas = await env
      .baseDe(EMPRESA)
      .collection('ledger_journal_entries')
      .find({ sourceType: { $in: ['platform_settlement', 'reversal:platform_settlement'] } })
      .toArray();
    expect(todas).toHaveLength(2);
    const lineas = todas.flatMap(
      (e) => e.lines as { accountCode: string; debit?: number; credit?: number }[],
    );
    const neto = lineas
      .filter((l) => l.accountCode === ACC.CLIENTES)
      .reduce((a, l) => a + (l.credit ?? 0) - (l.debit ?? 0), 0);
    expect(neto).toBe(0);
  });
});
