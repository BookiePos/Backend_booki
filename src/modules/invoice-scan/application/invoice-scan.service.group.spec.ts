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

import { InvoiceScanService } from './invoice-scan.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Diferenciación de facturas: el usuario dispara varias fotos seguidas y el
 * sistema tiene que decidir cuáles son páginas de un mismo documento y cuáles
 * son facturas distintas.
 *
 * La clave es el par NIT + número de factura. Sin número no se agrupa: dos
 * remisiones del mismo proveedor el mismo día se fusionarían en una sola,
 * mezclando mercancía de dos compras.
 */
describe('InvoiceScanService · agrupación de páginas', () => {
  const user = { userId: 'u1', email: 'due@negocio.com' } as unknown as JwtUser;

  function makeScan(
    lines: { description: string }[],
    meta: { doc?: string; number?: string } = {},
  ) {
    return {
      id: new Types.ObjectId().toString(),
      _id: new Types.ObjectId(),
      status: 'extracted',
      supplierDocNumber: meta.doc,
      invoiceNumber: meta.number,
      draft: {
        supplier: { docNumber: meta.doc },
        invoice: { number: meta.number },
        lines,
        totals: {},
      },
      pages: [{ imageUrl: 'u', imagePathname: 'p' }],
      lineDecisions: [],
      history: [],
      appliedTo: { expenseIds: [], createdProductIds: [] },
      save: vi.fn().mockResolvedValue(undefined),
      markModified: vi.fn(),
      deleteOne: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeService(scans: Record<string, unknown>) {
    const matching = {
      matchSupplier: vi.fn().mockResolvedValue({ mode: 'unknown' }),
      matchLines: vi.fn().mockResolvedValue([]),
      rememberAlias: vi.fn(),
    };
    const service = new InvoiceScanService(
      scans as never,
      {} as never,
      matching as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, matching };
  }

  let page1: ReturnType<typeof makeScan>;
  let page2: ReturnType<typeof makeScan>;

  beforeEach(() => {
    page1 = makeScan([{ description: 'Gaseosa' }], { doc: '900123456', number: 'FV-4821' });
    page2 = makeScan([{ description: 'Arroz' }], { doc: '900123456', number: 'FV-4821' });
  });

  it('une dos páginas de la misma factura y concatena sus líneas', async () => {
    const byId = new Map([
      [page1.id, page1],
      [page2.id, page2],
    ]);
    const scans = {
      findById: (id: string) => ({ exec: async () => byId.get(id) ?? null }),
    };
    const { service } = makeService(scans);

    const merged = await service.merge(page1.id, page2.id, user);

    expect(merged.pages).toHaveLength(2);
    expect((merged.draft as { lines: unknown[] }).lines).toHaveLength(2);
    // La página absorbida desaparece: tres fotos de dos facturas dejan dos
    // documentos, no cinco.
    expect(page2.deleteOne).toHaveBeenCalled();
    expect(merged.history.some((h) => h.action === 'merged')).toBe(true);
  });

  it('no une una factura ya aplicada', async () => {
    page1.status = 'applied';
    const byId = new Map([
      [page1.id, page1],
      [page2.id, page2],
    ]);
    const { service } = makeService({
      findById: (id: string) => ({ exec: async () => byId.get(id) ?? null }),
    });

    await expect(service.merge(page1.id, page2.id, user)).rejects.toThrow(
      /aplicada/i,
    );
    expect(page2.deleteOne).not.toHaveBeenCalled();
  });

  it('separa una página en una factura aparte', async () => {
    const scan = makeScan([{ description: 'Gaseosa' }]);
    scan.pages = [
      { imageUrl: 'a', imagePathname: 'pa' },
      { imageUrl: 'b', imagePathname: 'pb' },
    ];
    const created: Record<string, unknown>[] = [];
    const { service } = makeService({
      findById: () => ({ exec: async () => scan }),
      create: async (doc: Record<string, unknown>) => {
        created.push(doc);
        return doc;
      },
    });

    await service.split(scan.id, 1, user);

    expect(scan.pages).toHaveLength(1);
    expect(scan.pages[0]?.imagePathname).toBe('pa');
    expect(created[0]?.pages).toEqual([{ imageUrl: 'b', imagePathname: 'pb' }]);
  });

  it('no separa una factura de una sola página', async () => {
    const scan = makeScan([{ description: 'Gaseosa' }]);
    const { service } = makeService({ findById: () => ({ exec: async () => scan }) });
    await expect(service.split(scan.id, 0, user)).rejects.toThrow(/una sola página/i);
  });
});
