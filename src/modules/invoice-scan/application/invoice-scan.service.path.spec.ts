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
 * Qué camino toma la lectura.
 *
 * Si el PDF trae su capa de texto, los caracteres ya son exactos: reconocerlos
 * otra vez con un modelo de visión solo puede introducir errores en los precios
 * —pasó de verdad con una factura real, donde 4.450 se leyó como 4— además de
 * costar más y tardar más. La foto de una factura, en cambio, no tiene texto y
 * no queda otra que el OCR.
 *
 * Esta elección no se ve en la interfaz, así que sin test se rompería en
 * silencio: seguiría funcionando, solo que peor y más caro.
 */
describe('InvoiceScanService · texto del PDF vs OCR', () => {
  const user = { userId: 'u1', email: 'due@negocio.com' } as unknown as JwtUser;

  function makeScan(text?: string) {
    return {
      id: new Types.ObjectId().toString(),
      _id: new Types.ObjectId(),
      status: 'uploaded',
      pages: [{ imageUrl: 'https://blob/f.jpg', imagePathname: 'f.jpg', text }],
      lineDecisions: [],
      history: [] as { detail?: string }[],
      appliedTo: { expenseIds: [], createdProductIds: [] },
      draft: undefined as unknown,
      save: vi.fn().mockResolvedValue(undefined),
      markModified: vi.fn(),
    };
  }

  function result(model: string, lines: { description: string }[], totals = {}) {
    return {
      raw: {},
      parsed: { supplier: {}, invoice: {}, lines, totals },
      model,
      ms: 5,
    };
  }

  function makeService(scan: ReturnType<typeof makeScan>) {
    const extractor = {
      model: 'test',
      enabled: true,
      extract: vi.fn().mockResolvedValue(result('vision', [])),
      extractText: vi.fn().mockResolvedValue(result('texto', [])),
    };
    const matching = {
      matchSupplier: vi.fn().mockResolvedValue({ mode: 'unknown' }),
      matchLines: vi.fn().mockResolvedValue([]),
    };
    const scans = {
      findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(scan) }),
      findOne: vi.fn().mockReturnValue({
        sort: () => ({ exec: vi.fn().mockResolvedValue(null) }),
      }),
    };
    const service = new InvoiceScanService(
      scans as never,
      extractor as never,
      matching as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, extractor };
  }

  /** Descarga de imagen simulada: la lectura por OCR la necesita. */
  const imageFetch = () =>
    vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(8),
    }) as never;

  let fetchOriginal: typeof globalThis.fetch;

  beforeEach(() => {
    fetchOriginal = globalThis.fetch;
  });

  it('con texto del PDF lee sin OCR y sin descargar la imagen', async () => {
    const scan = makeScan('FARMATODO COLOMBIA S.A NIT 830.129.327-1 Total 7.425');
    const { service, extractor } = makeService(scan);
    extractor.extractText.mockResolvedValue(
      result('texto', [{ description: 'Gatorade 500 ml' }]),
    );
    // Si intentara descargar la imagen, este fetch lo delataría.
    globalThis.fetch = vi.fn(() => {
      throw new Error('no debería descargar la imagen');
    }) as never;

    try {
      await service.extract(scan.id, user);
    } finally {
      globalThis.fetch = fetchOriginal;
    }

    expect(extractor.extractText).toHaveBeenCalledOnce();
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(
      scan.history.some((h) => h.detail?.includes('del texto del PDF')),
    ).toBe(true);
  });

  it('sin texto descarga la imagen y usa el OCR', async () => {
    const scan = makeScan(undefined);
    const { service, extractor } = makeService(scan);
    globalThis.fetch = imageFetch();

    try {
      await service.extract(scan.id, user);
    } finally {
      globalThis.fetch = fetchOriginal;
    }

    expect(extractor.extract).toHaveBeenCalledOnce();
    expect(extractor.extractText).not.toHaveBeenCalled();
    expect(scan.history.some((h) => h.detail?.includes('por OCR'))).toBe(true);
  });

  it('si el texto del PDF no trae renglones, lee la imagen', async () => {
    // Caso real: los PDF de la "Solución Gratuita" de la DIAN traen en su capa
    // de texto solo el pie con los totales. Leído así, el borrador quedaba sin
    // proveedor ni renglones aunque la página renderizada los muestra.
    const scan = makeScan('Subtotal 157500 IVA 0,00 Total factura (=) 157500');
    const { service, extractor } = makeService(scan);
    extractor.extract.mockResolvedValue(
      result('vision', [{ description: 'Empaques kraft' }], { total: 157500 }),
    );
    globalThis.fetch = imageFetch();

    try {
      await service.extract(scan.id, user);
    } finally {
      globalThis.fetch = fetchOriginal;
    }

    expect(extractor.extractText).toHaveBeenCalledOnce();
    expect(extractor.extract).toHaveBeenCalledOnce();
    expect((scan.draft as { lines: unknown[] }).lines).toHaveLength(1);
    expect(
      scan.history.some((h) => h.detail?.includes('no traía renglones')),
    ).toBe(true);
  });

  it('si la imagen de respaldo falla, se queda con lo que dio el texto', async () => {
    const scan = makeScan('Subtotal 157500 Total factura (=) 157500');
    const { service, extractor } = makeService(scan);
    extractor.extractText.mockResolvedValue(result('texto', [], { total: 157500 }));
    extractor.extract.mockRejectedValue(new Error('el servicio no respondió'));
    globalThis.fetch = imageFetch();

    try {
      await service.extract(scan.id, user);
    } finally {
      globalThis.fetch = fetchOriginal;
    }

    expect(scan.status).toBe('extracted');
    expect((scan.draft as { totals: { total: number } }).totals.total).toBe(157500);
    expect(
      scan.history.some((h) => h.detail?.includes('del texto del PDF')),
    ).toBe(true);
  });
});
