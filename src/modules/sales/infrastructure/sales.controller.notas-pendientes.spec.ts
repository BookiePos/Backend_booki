import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { SalesController } from './sales.controller';

/** El listado y el detalle de ventas traen `documentoFiscal.notasPendientes` (Front_Booki #109). */
describe('SalesController · notasPendientes en la venta', () => {
  const user = { role: 'owner', sedeIds: [], permissions: [] } as never;
  const venta = { _id: 'v1', documentoFiscal: { estado: 'emitido', documentoId: 'd1' } };
  const anotar = vi.fn(async (vs: any[]) => vs.map((v) => ({ ...v, documentoFiscal: { ...v.documentoFiscal, notasPendientes: 2 } })));
  const sales = {
    list: vi.fn(async () => ({ total: 1, page: 1, limit: 20, rows: [venta] })),
    getForUser: vi.fn(async () => venta),
  };
  const ctl = new SalesController(sales as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { conNotasPendientes: anotar } as never);

  it('GET /sales anota cada fila y conserva la paginación', async () => {
    const r: any = await ctl.list(user, 's1');
    expect(r).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(r.rows[0].documentoFiscal.notasPendientes).toBe(2);
  });

  it('GET /sales/:id devuelve la venta anotada', async () => {
    const r: any = await ctl.get('v1', user);
    expect(r.documentoFiscal.notasPendientes).toBe(2);
    expect(anotar).toHaveBeenLastCalledWith([venta]);
  });
});
