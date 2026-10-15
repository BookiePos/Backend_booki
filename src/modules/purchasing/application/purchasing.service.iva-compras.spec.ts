import { describe, it, expect, vi } from 'vitest';
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

import { PurchasingService } from './purchasing.service';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import type { PostLine } from '../../core-ledger/application/ledger.service';
import { ACC } from '../../core-ledger/domain/ledger.constants';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import type { BusinessType } from '../../control/domain/control.constants';

/**
 * IVA de compras (ítem 1.4). La recepción creaba la CxP y el asiento solo con
 * `unitCost × qty`: el IVA de la factura no quedaba ni como descontable ni como
 * costo, y la CxP no alcanzaba para pagar la factura.
 *
 * - Responsable de IVA: inventario a la base, IVA descontable a la 2408 (débito;
 *   Decreto 2650/93, dinámica de la 2408; art. 488 ET) y CxP por el total.
 * - No responsable de IVA o restaurante que causa INC: el IVA es mayor valor del
 *   costo del inventario (arts. 437 y 488 ET; NIIF Pymes 13.6), también en el
 *   costo del lote para que el costo de venta lo recoja.
 * - De contado: se acredita el medio de pago real (efectivo → Caja; lo demás →
 *   Bancos), no una cuenta fija.
 *
 * Se usa el `LedgerPostingService` real sobre un libro falso para ver el
 * asiento completo y que cuadre.
 *
 * Constructor: (orders, payables, counterModel, stock, products, tax,
 * ledgerPosting, sedes, businesses).
 */
describe('PurchasingService.receive · IVA de compras', () => {
  const sedeId = new Types.ObjectId();
  const ARROZ = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'compras@bookipos.local',
    role: 'admin',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  /** OC de 10 arrobas de arroz a $10.000 + IVA 19 % ($19.000). */
  function orden() {
    return {
      _id: new Types.ObjectId(),
      id: 'oc1',
      number: 'OC-000010',
      sedeId,
      supplierName: 'Granos del Tolima',
      status: 'sent',
      lines: [
        {
          productId: ARROZ,
          description: 'ARROZ',
          qty: 10,
          qtyReceived: 0,
          unitCost: 10_000,
          taxCode: 'IVA_19',
          subtotal: 100_000,
          taxAmount: 19_000,
        },
      ],
      receipts: [],
      markModified: vi.fn(),
    };
  }

  function build(responsabilidadFiscal: string) {
    const po: any = orden();
    const orders = {
      findById: vi.fn(() => ({ exec: () => Promise.resolve(po) })),
      findOneAndUpdate: vi.fn((_f: unknown, upd: any) => {
        const [path, qty] = Object.entries(upd.$inc)[0] as [string, number];
        const idx = Number(path.split('.')[1]);
        const advanced = structuredClone({ lines: po.lines.map((l: any) => ({ qty: l.qty, qtyReceived: l.qtyReceived })) });
        advanced.lines[idx].qtyReceived += qty;
        return { exec: () => Promise.resolve(advanced) };
      }),
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
    };
    const payables = {
      create: vi.fn((docs: any[]) =>
        Promise.resolve(docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))),
      ),
    };
    const stock = { entry: vi.fn().mockResolvedValue(undefined) };
    const ledger = {
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockResolvedValue(undefined),
    };
    const sedes = {
      findById: vi.fn(() => ({
        select: () => ({ exec: () => Promise.resolve({ responsabilidadFiscal }) }),
      })),
    };
    const service = new PurchasingService(
      orders as never,
      payables as never,
      {} as never,
      stock as never,
      {} as never,
      {} as never,
      new LedgerPostingService(ledger as never, { registrar: vi.fn() } as never),
      sedes as never,
      { findById: async () => null } as never,
    );
    return { service, po, payables, stock, ledger };
  }

  async function recibir(
    tipoNegocio: BusinessType,
    responsabilidadFiscal: string,
    extra: Record<string, unknown>,
    qty = 10,
  ) {
    const ctx = build(responsabilidadFiscal);
    await TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', tipoNegocio }, () =>
      ctx.service.receive(
        'oc1',
        { date: '2026-10-13', lines: [{ lineIndex: 0, qty }], ...extra } as never,
        user,
      ),
    );
    const calls: any[] = ctx.ledger.post.mock.calls;
    const lines: PostLine[] = calls[calls.length - 1]?.[0].lines ?? [];
    const cxp = (): number => (ctx.payables.create.mock.calls as any)[0][0][0].amount;
    const on = (code: string, side: 'debit' | 'credit') =>
      lines.filter((l) => l.accountCode === code).reduce((a, l) => a + (l[side] ?? 0), 0);
    const total = (side: 'debit' | 'credit') => lines.reduce((a, l) => a + (l[side] ?? 0), 0);
    return { ...ctx, lines, on, total, cxp };
  }

  it('a crédito, responsable de IVA: CxP por el total, IVA a la 2408, inventario a la base', async () => {
    const r = await recibir('retail', 'responsable_iva', { generatePayable: true });

    expect(r.cxp()).toBe(119_000);
    expect(r.total('debit')).toBe(r.total('credit'));
    expect(r.on(ACC.INVENTARIO, 'debit')).toBe(100_000);
    expect(r.on(ACC.IVA_POR_PAGAR, 'debit')).toBe(19_000);
    expect(r.on(ACC.PROVEEDORES, 'credit')).toBe(119_000);
    expect((r.stock.entry.mock.calls as any)[0][0].unitCost).toBe(10_000);
  });

  it('a crédito, no responsable de IVA: el IVA es costo del inventario (y del lote)', async () => {
    const r = await recibir('retail', 'no_responsable_iva', { generatePayable: true });

    expect(r.cxp()).toBe(119_000);
    expect(r.total('debit')).toBe(r.total('credit'));
    expect(r.on(ACC.INVENTARIO, 'debit')).toBe(119_000);
    expect(r.on(ACC.IVA_POR_PAGAR, 'debit')).toBe(0);
    expect(r.on(ACC.PROVEEDORES, 'credit')).toBe(119_000);
    // El costo de venta sale de los lotes: el lote tiene que traer el IVA.
    expect((r.stock.entry.mock.calls as any)[0][0].unitCost).toBe(11_900);
  });

  it('restaurante que causa INC: tampoco descuenta el IVA de la compra', async () => {
    const r = await recibir('restaurante', 'responsable_iva', { generatePayable: true });

    expect(r.on(ACC.INVENTARIO, 'debit')).toBe(119_000);
    expect(r.on(ACC.IVA_POR_PAGAR, 'debit')).toBe(0);
  });

  it('de contado en efectivo: sale de Caja por el total de la factura', async () => {
    const r = await recibir('retail', 'responsable_iva', { paymentMethod: 'cash' });

    expect(r.payables.create).not.toHaveBeenCalled();
    expect(r.total('debit')).toBe(r.total('credit'));
    expect(r.on(ACC.CAJA, 'credit')).toBe(119_000);
    expect(r.on(ACC.BANCOS, 'credit')).toBe(0);
  });

  it('de contado por transferencia: sale de Bancos, no de Caja', async () => {
    const r = await recibir('retail', 'responsable_iva', { paymentMethod: 'transfer' });

    expect(r.total('debit')).toBe(r.total('credit'));
    expect(r.on(ACC.BANCOS, 'credit')).toBe(119_000);
    expect(r.on(ACC.CAJA, 'credit')).toBe(0);
  });

  it('una recepción parcial lleva su parte del IVA, sin fracciones de peso', async () => {
    // 3 de 10: 19.000 × 0,3 = 5.700.
    const r = await recibir('retail', 'responsable_iva', { generatePayable: true }, 3);

    expect(r.cxp()).toBe(35_700);
    expect(r.on(ACC.IVA_POR_PAGAR, 'debit')).toBe(5_700);
    expect(r.total('debit')).toBe(r.total('credit'));
  });

  it('dos recepciones concurrentes: cada una tiene su asiento y su recepción (ítem 1.4, id estable)', async () => {
    // Las dos leen la orden antes de que la otra guarde: ambas ven 0 recepciones.
    // Con el id `${po._id}:${receipts.length - 1}` las dos daban `:0` y el
    // ledger (idempotente por sourceId) descartaba el segundo asiento.
    const ctx = build('responsable_iva');
    const recibir3 = () =>
      TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', tipoNegocio: 'retail' }, () =>
        ctx.service.receive(
          'oc1',
          { date: '2026-10-13', lines: [{ lineIndex: 0, qty: 3 }], generatePayable: true } as never,
          user,
        ),
      );
    await recibir3();
    ctx.po.receipts = [];
    await recibir3();

    const ids = (ctx.ledger.post.mock.calls as any[]).map((c) => c[0].sourceId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // La recepción se agrega ($push), no se reescribe la lista: la otra no se pierde.
    const updates = (ctx.service as any).orders.updateOne.mock.calls as any[];
    for (const [, upd] of updates) {
      expect(upd.$set?.receipts).toBeUndefined();
      expect(upd.$push?.receipts).toBeDefined();
    }
    // El id del asiento es el de la recepción guardada.
    const pushed = updates.map(([, upd]) => String(upd.$push.receipts._id));
    expect(ids.map((id: string) => id.split(':')[1])).toEqual(pushed);
  });
});
