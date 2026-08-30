import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Aquí los modelos van
// mockeados. Mismo patrón que `sales/application/orders.service.checkout.spec.ts`.
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

import { CatalogService, type UploadedImage } from './catalog.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * Foto de un producto vendible.
 *
 * Lo que se protege aquí es el ORDEN: subir la nueva, guardar el producto y
 * solo entonces borrar la anterior. Invertirlo deja fichas apuntando a archivos
 * que ya no existen, que es el fallo caro (y silencioso) de este flujo.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas:
 * (model, productModel, categoryModel, inventory, storage).
 */
describe('CatalogService · imagen del producto', () => {
  const productId = new Types.ObjectId().toString();
  const ctx = { businessId: 'b1', dbName: 'biz_b1' };

  /** Documento con las llamadas registradas en el orden en que ocurren. */
  function makeProduct(orden: string[], imagePathname?: string) {
    return {
      id: productId,
      imageUrl: imagePathname ? 'https://blob/vieja.jpg' : undefined,
      imagePathname,
      save: vi.fn().mockImplementation(() => {
        orden.push('save');
        return Promise.resolve(undefined);
      }),
    };
  }

  function makeDeps(product: ReturnType<typeof makeProduct>, orden: string[]) {
    // findById sirve a dos usos: `.exec()` directo y la cadena de populate de
    // getOrFail. El stub encadena consigo mismo.
    const query: Record<string, unknown> = {};
    query.populate = () => query;
    query.exec = vi.fn().mockResolvedValue(product);
    const model = { findById: vi.fn().mockReturnValue(query) };

    const storage = {
      upload: vi.fn().mockImplementation((pathname: string) => {
        orden.push('upload');
        return Promise.resolve({ url: `https://blob/${pathname}`, pathname });
      }),
      remove: vi.fn().mockImplementation(() => {
        orden.push('remove');
        return Promise.resolve(undefined);
      }),
    };
    return { model, storage };
  }

  function makeService(deps: ReturnType<typeof makeDeps>) {
    return new CatalogService(
      deps.model as never,
      {} as never,
      {} as never,
      {} as never,
      deps.storage as never,
    );
  }

  const jpg: UploadedImage = {
    buffer: Buffer.from('imagen'),
    mimetype: 'image/jpeg',
    size: 6,
  };

  let orden: string[];

  beforeEach(() => {
    orden = [];
  });

  it('sube, guarda y solo entonces borra la foto anterior', async () => {
    const product = makeProduct(orden, 'catalogo/b1/vieja.jpg');
    const deps = makeDeps(product, orden);
    const service = makeService(deps);

    await TenantContext.run(ctx, () => service.setImage(productId, jpg));

    expect(orden).toEqual(['upload', 'save', 'remove']);
    expect(deps.storage.remove).toHaveBeenCalledWith('catalogo/b1/vieja.jpg');
    expect(product.imageUrl).toContain('https://blob/catalogo/b1/');
  });

  it('guarda bajo la empresa activa y con nombre irrepetible', async () => {
    const product = makeProduct(orden);
    const deps = makeDeps(product, orden);
    const service = makeService(deps);

    await TenantContext.run(ctx, () => service.setImage(productId, jpg));
    const primera = deps.storage.upload.mock.calls[0][0] as string;

    orden.length = 0;
    await TenantContext.run(ctx, () => service.setImage(productId, jpg));
    const segunda = deps.storage.upload.mock.calls[1][0] as string;

    expect(primera).toMatch(
      new RegExp(`^catalogo/b1/${productId}-[0-9a-f]{12}\\.jpg$`),
    );
    // Dos subidas del mismo producto no comparten ruta: si la compartieran, la
    // CDN seguiría sirviendo la foto vieja desde su caché.
    expect(segunda).not.toBe(primera);
  });

  it('sin foto previa no intenta borrar nada', async () => {
    const product = makeProduct(orden);
    const deps = makeDeps(product, orden);
    const service = makeService(deps);

    await TenantContext.run(ctx, () => service.setImage(productId, jpg));

    expect(orden).toEqual(['upload', 'save']);
    expect(deps.storage.remove).not.toHaveBeenCalled();
  });

  it('rechaza un formato que no es imagen, sin tocar el store', async () => {
    const product = makeProduct(orden);
    const deps = makeDeps(product, orden);
    const service = makeService(deps);

    await expect(
      TenantContext.run(ctx, () =>
        service.setImage(productId, {
          ...jpg,
          mimetype: 'application/pdf',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.storage.upload).not.toHaveBeenCalled();
  });

  it('rechaza una imagen más grande que el límite', async () => {
    const product = makeProduct(orden);
    const deps = makeDeps(product, orden);
    const service = makeService(deps);

    await expect(
      TenantContext.run(ctx, () =>
        service.setImage(productId, { ...jpg, size: 8 * 1024 * 1024 }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.storage.upload).not.toHaveBeenCalled();
  });

  it('quitar la foto limpia la ficha y borra el archivo', async () => {
    const product = makeProduct(orden, 'catalogo/b1/vieja.jpg');
    const deps = makeDeps(product, orden);
    const service = makeService(deps);

    await TenantContext.run(ctx, () => service.removeImage(productId));

    expect(product.imageUrl).toBeUndefined();
    expect(product.imagePathname).toBeUndefined();
    expect(orden).toEqual(['save', 'remove']);
  });
});
