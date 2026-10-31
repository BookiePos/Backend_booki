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

import { SalesController } from './sales.controller';
import { PERMISSIONS_KEY } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** Venta directa (`POST /sales`) con documento fiscal (PR 7B). */
describe('SalesController.create · documento fiscal', () => {
  const user = { userId: 'u1', email: 'c@x.co', sedeIds: [], permissions: ['pos.sell'] } as unknown as JwtUser;

  function build() {
    const orden: string[] = [];
    const sale = { _id: new Types.ObjectId() };
    const sales = { create: vi.fn(async () => (orden.push('venta'), sale)) };
    const documentoFiscal = {
      alCobrar: vi.fn(async (s: any) => (orden.push('documento'), s)),
    };
    const ctl = new SalesController(sales as any, {} as any, {} as any, {} as any, documentoFiscal as any);
    return { ctl, sales, documentoFiscal, orden, sale };
  }

  it('crea la venta y DESPUÉS pide el documento fiscal; devuelve la venta', async () => {
    const { ctl, documentoFiscal, orden, sale } = build();
    const dto = { sedeId: 's', lines: [], payment: { method: 'cash' }, documentoFiscal: 'pos_identificado' } as any;
    await expect(ctl.create(dto, user)).resolves.toBe(sale);
    expect(orden).toEqual(['venta', 'documento']);
    expect(documentoFiscal.alCobrar).toHaveBeenCalledWith(sale, 'pos_identificado', user);
  });

  it('si la venta falla, no se pide documento y el error se propaga', async () => {
    const { ctl, sales, documentoFiscal } = build();
    sales.create.mockRejectedValue(new Error('sin stock'));
    await expect(ctl.create({} as any, user)).rejects.toThrow('sin stock');
    expect(documentoFiscal.alCobrar).not.toHaveBeenCalled();
  });

  it('el permiso sigue siendo pos.sell: el Cajero emite el POS de su venta sin einvoicing.issue', () => {
    const meta = Reflect.getMetadata(PERMISSIONS_KEY, SalesController.prototype.create);
    expect(meta).toEqual([PERMISSIONS.POS_SELL]);
  });
});
