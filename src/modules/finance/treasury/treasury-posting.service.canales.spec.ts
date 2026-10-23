import { describe, it, expect, vi } from 'vitest';

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

import { Types } from 'mongoose';
import { TreasuryPostingService } from './treasury-posting.service';

/**
 * Ítem 6.4: cada negocio mapea Nequi, Daviplata, QR o datáfono a su cuenta de
 * tesorería; sin mapeo cae a la cuenta del medio de siempre.
 */
describe('TreasuryPostingService · canales', () => {
  const sede = new Types.ObjectId().toString();
  const nequi = { _id: new Types.ObjectId(), sedeId: null, autoMethods: ['nequi'] };
  const banco = { _id: new Types.ObjectId(), sedeId: null, autoMethods: ['transfer', 'card'] };

  function build(accounts: any[]) {
    const created: any[] = [];
    const accountsModel = {
      find: vi.fn((q: any) => ({
        exec: () =>
          Promise.resolve(accounts.filter((a) => a.autoMethods.includes(q.autoMethods))),
      })),
    };
    const movements = {
      create: vi.fn((d: any) => {
        created.push(d);
        return Promise.resolve(d);
      }),
      deleteMany: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
    };
    return {
      service: new TreasuryPostingService(accountsModel as never, movements as never),
      created,
      movements,
    };
  }

  const post = (channel?: string) => ({
    sourceType: 'sale' as const,
    sourceId: 's1',
    sedeId: sede,
    method: 'transfer' as const,
    channel,
    direction: 'in' as const,
    amount: 10_000,
    date: '2026-10-22',
    concept: 'Venta',
  });

  it('con cuenta mapeada al canal, el cobro por Nequi entra a ella', async () => {
    const { service, created } = build([nequi, banco]);
    await service.post(post('nequi'));
    expect(created[0].accountId).toBe(nequi._id);
  });

  it('sin cuenta para el canal cae a la cuenta de transferencias', async () => {
    const { service, created } = build([nequi, banco]);
    await service.post(post('daviplata'));
    expect(created[0].accountId).toBe(banco._id);
  });

  it('sin canal se comporta como siempre', async () => {
    const { service, created } = build([nequi, banco]);
    await service.post(post());
    expect(created[0].accountId).toBe(banco._id);
  });

  it('al anular una venta quita también los movimientos por canal (<id>:<canal>)', async () => {
    const { service, movements } = build([]);
    await service.reverse('sale', ['abc', 'abc:card']);
    const filter = (movements.deleteMany.mock.calls[0] as unknown[])[0] as any;
    expect(filter.sourceType).toBe('sale');
    expect(filter.$or[0].sourceId.$in).toEqual(['abc', 'abc:card']);
    expect(new RegExp(filter.$or[1].sourceId.$regex).test('abc:nequi')).toBe(true);
    expect(new RegExp(filter.$or[1].sourceId.$regex).test('abcd:nequi')).toBe(false);
  });

  it('otros orígenes no se tocan por prefijo', async () => {
    const { service, movements } = build([]);
    await service.reverse('expense', 'e1');
    const filter = (movements.deleteMany.mock.calls[0] as unknown[])[0] as any;
    expect(filter.$or).toBeUndefined();
    expect(filter.sourceId).toEqual({ $in: ['e1'] });
  });
});
