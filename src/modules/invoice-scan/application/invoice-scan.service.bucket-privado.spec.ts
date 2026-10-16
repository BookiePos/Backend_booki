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

import { InvoiceScanService } from './invoice-scan.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 3.8: una factura de compra trae NIT, precios y condiciones del
 * proveedor. Antes quedaba en un bucket público y la protegía solo el
 * aleatorio de su ruta: quien tuviera el enlace (un log, un correo reenviado)
 * la veía para siempre. Ahora va a un bucket privado y el API entrega una URL
 * firmada que vence.
 */
describe('InvoiceScanService · facturas en bucket privado', () => {
  // El Dueño: ve todas las sedes (las facturas se filtran por sede, ítem 3.10).
  const user = {
    userId: 'u1',
    email: 'due@negocio.com',
    role: 'owner',
    permissions: [],
    sedeIds: [],
  } as unknown as JwtUser;
  const ctx = { businessId: 'b1', dbName: 'biz_b1', plan: 'pro' } as never;
  const jpeg = {
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
    mimetype: 'image/jpeg',
    size: 1024,
    originalname: 'factura.jpg',
  };

  function makeStorage() {
    return {
      assertAvailable: vi.fn(),
      upload: vi.fn(),
      uploadPrivado: vi.fn(async (pathname: string) => ({ pathname })),
      firmarUrls: vi.fn(async (paths: string[]) =>
        Object.fromEntries(paths.map((p) => [p, `https://firmada/${p}?token=t`])),
      ),
      descargarPrivado: vi.fn().mockResolvedValue({
        buffer: Buffer.from([1, 2, 3]),
        mimetype: 'image/jpeg',
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeService(storage: ReturnType<typeof makeStorage>, scan?: unknown) {
    const scans = {
      create: vi.fn(async (doc: unknown) => doc),
      findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(scan) }),
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ extractions: 1 }),
      }),
      findOne: vi.fn().mockReturnValue({
        sort: () => ({ exec: vi.fn().mockResolvedValue(null) }),
      }),
    };
    const extractor = {
      model: 'test',
      enabled: true,
      extract: vi.fn().mockResolvedValue({
        raw: {},
        parsed: { supplier: {}, invoice: {}, lines: [], totals: {} },
        model: 'vision',
        ms: 10,
      }),
    };
    const matching = {
      matchSupplier: vi.fn().mockResolvedValue({ mode: 'unknown' }),
      matchLines: vi.fn().mockResolvedValue([]),
    };
    const service = new InvoiceScanService(
      scans as never,
      extractor as never,
      matching as never,
      storage as never,
      { consumeScan: vi.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, scans, extractor };
  }

  it('la factura nueva se sube al bucket privado y no guarda URL pública', async () => {
    const storage = makeStorage();
    const { service, scans } = makeService(storage);

    await TenantContext.run(ctx, () => service.upload(jpeg, user));

    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.uploadPrivado).toHaveBeenCalledOnce();
    const page = (scans.create.mock.calls[0]![0] as { pages: Record<string, unknown>[] })
      .pages[0]!;
    expect(page.privada).toBe(true);
    expect(page.imagePathname).toMatch(/^facturas\/b1\//);
    expect(page.imageUrl).toBeUndefined();
  });

  it('la respuesta lleva URL firmada en las páginas privadas y deja igual las viejas', async () => {
    const storage = makeStorage();
    const { service } = makeService(storage);
    const scan = {
      toJSON: () => ({
        id: 's1',
        pages: [
          { imagePathname: 'facturas/b1/nueva.jpg', privada: true },
          { imageUrl: 'https://publica/vieja.jpg', imagePathname: 'facturas/b1/vieja.jpg' },
        ],
      }),
    };

    const [out] = await service.conUrlsFirmadas([scan as never]);

    expect(storage.firmarUrls).toHaveBeenCalledWith(['facturas/b1/nueva.jpg']);
    expect(out!.pages[0]!.imageUrl).toBe('https://firmada/facturas/b1/nueva.jpg?token=t');
    expect(out!.pages[1]!.imageUrl).toBe('https://publica/vieja.jpg');
  });

  it('para leerla la descarga con la llave del servidor, no por una URL', async () => {
    const storage = makeStorage();
    const scan = {
      id: new Types.ObjectId().toString(),
      _id: new Types.ObjectId(),
      status: 'uploaded',
      pages: [{ imagePathname: 'facturas/b1/f.jpg', privada: true }],
      lineDecisions: [],
      history: [] as { detail?: string }[],
      appliedTo: { expenseIds: [], createdProductIds: [] },
      save: vi.fn().mockResolvedValue(undefined),
      markModified: vi.fn(),
    };
    const { service, extractor } = makeService(storage, scan);
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn(() => {
      throw new Error('no debería descargar por URL');
    }) as never;

    try {
      await service.extract(scan.id, user);
    } finally {
      globalThis.fetch = fetchOriginal;
    }

    expect(storage.descargarPrivado).toHaveBeenCalledWith('facturas/b1/f.jpg');
    expect(extractor.extract).toHaveBeenCalledOnce();
  });

  it('al descartar borra cada archivo de su bucket', async () => {
    const storage = makeStorage();
    const scan = {
      status: 'extracted',
      pages: [
        { imagePathname: 'facturas/b1/nueva.jpg', privada: true },
        { imageUrl: 'https://publica/vieja.jpg', imagePathname: 'facturas/b1/vieja.jpg' },
      ],
      history: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    const { service } = makeService(storage, scan);

    await service.discard(new Types.ObjectId().toString(), user);

    expect(storage.remove).toHaveBeenCalledWith('facturas/b1/nueva.jpg', { privado: true });
    expect(storage.remove).toHaveBeenCalledWith('facturas/b1/vieja.jpg', { privado: false });
  });
});
