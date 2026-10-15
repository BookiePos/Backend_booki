import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';

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
import { PlanUpgradeRequiredException } from '../../control/domain/plan-upgrade.exception';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import {
  INVOICE_FREE_EXTRACTIONS,
  INVOICE_TEXT_MAX_CHARS,
  INVOICE_XML_MAX_CHARS,
} from '../domain/invoice-scan.constants';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Costo de IA con tope (checklist 4.6). La subida cobra un escaneo; leerlo de
 * nuevo (`extract`) llama al modelo otra vez y no puede ser gratis e ilimitado.
 */
describe('InvoiceScanService · extract con tope de costo', () => {
  const user = { userId: 'u1', email: 'due@negocio.com' } as unknown as JwtUser;
  const ctx = { businessId: 'b1', dbName: 'biz_b1', plan: 'pro' } as never;

  function makeService(extractions: number, consumeScan = vi.fn()) {
    // Contador atómico simulado: cada $inc devuelve el valor nuevo, con una espera
    // para que dos extract concurrentes se entrelacen.
    let counter = extractions;
    const findOneAndUpdate = vi.fn((_f: unknown, upd: { $inc: { extractions: number } }) => ({
      exec: async () => {
        await new Promise((r) => setTimeout(r, 5));
        counter += upd.$inc.extractions;
        return { extractions: counter };
      },
    }));
    const updateOne = vi.fn((_f: unknown, upd: { $inc: { extractions: number } }) => ({
      exec: async () => {
        counter += upd.$inc.extractions;
      },
    }));
    const result = {
      raw: {},
      model: 'm',
      ms: 1,
      parsed: { supplier: {}, invoice: {}, lines: [] },
    };
    const extractor = {
      extract: vi.fn().mockResolvedValue(result),
      extractText: vi.fn().mockResolvedValue(result),
    };
    const matching = {
      matchSupplier: vi.fn().mockResolvedValue({ mode: 'none' }),
      matchLines: vi.fn().mockResolvedValue([]),
    };
    const scan = {
      status: 'extracted',
      extractions,
      history: [],
      pages: [{ imageUrl: 'u', text: 'x'.repeat(INVOICE_TEXT_MAX_CHARS + 500) }],
      save: vi.fn().mockResolvedValue(undefined),
    };
    const service = new InvoiceScanService(
      { findOne: vi.fn().mockResolvedValue(null), findOneAndUpdate, updateOne } as never,
      extractor as never,
      matching as never,
      {} as never,
      { consumeScan } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(service, 'getOrFail').mockResolvedValue(scan as never);
    return { service, scan, extractor, consumeScan, findOneAndUpdate, count: () => counter };
  }

  it('las lecturas dentro del tope no cobran otro escaneo', async () => {
    const { service, consumeScan, count } = makeService(0);
    await TenantContext.run(ctx, () => service.extract('s1', user)).catch(() => undefined);
    expect(consumeScan).not.toHaveBeenCalled();
    expect(count()).toBe(1);
  });

  it('pasado el tope consume cuota, y sin cuota responde 402 sin llamar al modelo', async () => {
    const consumeScan = vi.fn().mockRejectedValue(
      new PlanUpgradeRequiredException('tope', { reason: 'quota', quota: 'invoiceScans' }),
    );
    const { service, extractor, count } = makeService(INVOICE_FREE_EXTRACTIONS, consumeScan);
    await expect(
      TenantContext.run(ctx, () => service.extract('s1', user)),
    ).rejects.toMatchObject({ status: 402 });
    expect(consumeScan).toHaveBeenCalledWith('b1', 'pro');
    expect(count()).toBe(INVOICE_FREE_EXTRACTIONS); // el $inc se revirtió
    expect(extractor.extractText).not.toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it('dos extract a la vez no se saltan el tope: el segundo cobra', async () => {
    const { service, consumeScan, count } = makeService(INVOICE_FREE_EXTRACTIONS - 1);
    await Promise.all([
      TenantContext.run(ctx, () => service.extract('s1', user)).catch(() => undefined),
      TenantContext.run(ctx, () => service.extract('s1', user)).catch(() => undefined),
    ]);
    expect(count()).toBe(INVOICE_FREE_EXTRACTIONS + 1);
    expect(consumeScan).toHaveBeenCalledTimes(1);
  });

  it('recorta el texto que se envía al modelo', async () => {
    const { service, extractor } = makeService(0);
    await TenantContext.run(ctx, () => service.extract('s1', user)).catch(() => undefined);
    expect(extractor.extractText.mock.calls[0]![0].length).toBe(INVOICE_TEXT_MAX_CHARS);
  });
});

describe('InvoiceScanController · límites de IA', () => {
  const big = 'x'.repeat(INVOICE_TEXT_MAX_CHARS + 1);
  const file = { buffer: Buffer.alloc(1), size: 1 } as never;
  const user = {} as JwtUser;

  it('texto de más de 200 KB en upload responde 400', () => {
    const c = new InvoiceScanController({ upload: vi.fn() } as never);
    expect(() => c.upload(file, user, big)).toThrow(BadRequestException);
  });

  it('xml: pasa con 1,5 MB (no usa IA) y responde 400 por encima de 2 MB', () => {
    const upload = vi.fn();
    const c = new InvoiceScanController({ upload } as never);
    c.upload(file, user, undefined, 'x'.repeat(1_500_000));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(() => c.upload(file, user, undefined, 'x'.repeat(INVOICE_XML_MAX_CHARS + 1))).toThrow(
      BadRequestException,
    );
  });

  it('upload y extract declaran @Throttle propio', () => {
    for (const name of ['upload', 'extract'] as const) {
      const handler = InvoiceScanController.prototype[name];
      const keys = Reflect.getMetadataKeys(handler).filter((k) => String(k).startsWith('THROTTLER'));
      expect(keys.length, name).toBeGreaterThan(0);
    }
  });
});
