import 'reflect-metadata';
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

import { InvoiceScanService } from './invoice-scan.service';
import { InvoiceScanController } from '../infrastructure/invoice-scan.controller';
import { businessTracker } from '../infrastructure/ai-throttle';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { INVOICE_FREE_EXTRACTIONS } from '../domain/invoice-scan.constants';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const user = { userId: 'u1', email: 'due@negocio.com' } as unknown as JwtUser;
const ctx = { businessId: 'b1', dbName: 'biz_b1', plan: 'pro' } as never;

function fakeScan(extractions: number, pages = 1) {
  return {
    status: 'extracted',
    extractions,
    history: [],
    draft: { supplier: {}, invoice: {}, lines: [] },
    pages: Array.from({ length: pages }, (_, i) => ({ imageUrl: `u${i}` })),
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    deleteOne: vi.fn().mockResolvedValue(undefined),
  };
}

function makeService() {
  const create = vi.fn().mockImplementation(async (d: unknown) => d);
  const service = new InvoiceScanService(
    { create } as never,
    {} as never,
    { matchSupplier: vi.fn().mockResolvedValue({ mode: 'none' }), matchLines: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, create };
}

describe('4.6 · el contador de lecturas sobrevive a merge y split', () => {
  it('extract -> merge -> split no regala lecturas: el separado hereda el contador', async () => {
    const { service, create } = makeService();
    const target = fakeScan(INVOICE_FREE_EXTRACTIONS);
    const source = fakeScan(0);
    vi.spyOn(service, 'getOrFail')
      .mockResolvedValueOnce(target as never)
      .mockResolvedValueOnce(source as never);
    await TenantContext.run(ctx, () => service.merge('t', 's', user));
    expect(target.extractions).toBe(INVOICE_FREE_EXTRACTIONS);

    target.pages = [{ imageUrl: 'a' }, { imageUrl: 'b' }] as never;
    vi.spyOn(service, 'getOrFail').mockResolvedValue(target as never);
    await service.split('t', 1, user);
    expect(create.mock.calls[0]![0].extractions).toBe(INVOICE_FREE_EXTRACTIONS);
  });

  it('merge conserva el máximo de las dos facturas (cada una ya pagó su escaneo)', async () => {
    const { service } = makeService();
    const target = fakeScan(1);
    const source = fakeScan(3);
    vi.spyOn(service, 'getOrFail')
      .mockResolvedValueOnce(target as never)
      .mockResolvedValueOnce(source as never);
    await TenantContext.run(ctx, () => service.merge('t', 's', user));
    expect(target.extractions).toBe(3);
  });
});

describe('4.6 · modelo que falla después de cobrar', () => {
  it('no revierte el contador ni devuelve el escaneo: la lectura cobrada ya se hizo', async () => {
    const updateOne = vi.fn();
    const consumeScan = vi.fn().mockResolvedValue(undefined);
    const scan = { ...fakeScan(0), pages: [{ imageUrl: 'u', text: 'hola' }] };
    const service = new InvoiceScanService(
      {
        findOneAndUpdate: () => ({ exec: async () => ({ extractions: INVOICE_FREE_EXTRACTIONS + 1 }) }),
        updateOne,
      } as never,
      { extractText: vi.fn().mockRejectedValue(new Error('modelo caído')) } as never,
      {} as never,
      {} as never,
      { consumeScan } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(service, 'getOrFail').mockResolvedValue(scan as never);
    await expect(TenantContext.run(ctx, () => service.extract('s', user))).rejects.toThrow('modelo caído');
    expect(consumeScan).toHaveBeenCalledTimes(1);
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('4.6 · throttle por negocio', () => {
  it('el tracker usa el businessId, y la IP solo si no hay negocio', async () => {
    const req = { ip: '1.2.3.4' };
    expect(await TenantContext.run(ctx, () => businessTracker(req as never))).toBe('biz:b1');
    expect(await businessTracker(req as never)).toBe('ip:1.2.3.4');
  });

  it('upload y extract declaran ese tracker', () => {
    for (const name of ['upload', 'extract'] as const) {
      const t = Reflect.getMetadata('THROTTLER:TRACKERdefault', InvoiceScanController.prototype[name]);
      expect(t, name).toBe(businessTracker);
    }
  });
});
