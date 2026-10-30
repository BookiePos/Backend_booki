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

import { SalesService } from './sales.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** El POS necesita saber qué productos llevan bolsa para sumar el INC. */
describe('SalesService · pos-products · bolsaPlastica', () => {
  const sedeId = new Types.ObjectId().toString();
  const duena = { userId: 'u1', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;

  function producto(over: Record<string, unknown>) {
    return { _id: new Types.ObjectId(), sku: 'X', name: 'X', salePrice: 1000, ...over };
  }

  async function correr(productos: unknown[]) {
    const catalog = {
      listSellable: vi.fn().mockResolvedValue(productos),
      componentsOf: vi.fn().mockReturnValue([]),
      variantInfoOf: vi.fn().mockReturnValue(null),
      barcodeOf: vi.fn().mockReturnValue(null),
    };
    const service = Object.create(SalesService.prototype) as Record<string, unknown>;
    service.sedes = { findOrFail: vi.fn().mockResolvedValue({}) };
    service.catalog = catalog;
    service.stockItemModel = { find: () => ({ exec: () => Promise.resolve([]) }) };
    return (service as unknown as SalesService).posProducts(sedeId, duena);
  }

  it('devuelve true solo en los productos marcados y false en el resto', async () => {
    const r = await correr([
      producto({ bolsaPlastica: true }),
      producto({ bolsaPlastica: false }),
      producto({}),
    ]);
    expect(r.map((p) => p.bolsaPlastica)).toEqual([true, false, false]);
  });
});
