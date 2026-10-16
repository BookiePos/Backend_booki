import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';

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
import { StorageService } from '../../../shared/storage/storage.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Qué cuesta un escaneo.
 *
 * La cuota mensual se consume al subir, no al leer. Eso está bien mientras la
 * subida realmente guarde algo: si el store no está configurado el API responde
 * 503 y no queda ni archivo ni factura, así que cobrar ahí le quema al negocio
 * un escaneo por cada reintento —y sin `BLOB_READ_WRITE_TOKEN` en producción
 * fueron muchos—. Pasó de verdad; sin test volvería a pasar en silencio, porque
 * el cliente ve el mismo 503 se cobre o no.
 */
describe('InvoiceScanService · cuota al subir', () => {
  const user = { userId: 'u1', email: 'due@negocio.com' } as unknown as JwtUser;
  const ctx = { businessId: 'b1', dbName: 'biz_b1', plan: 'pro' } as never;

  const file = {
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
    mimetype: 'image/jpeg',
    size: 1024,
    originalname: 'factura.jpg',
  };

  /** El constructor es: (scans, extractor, matching, storage, businesses, ...). */
  function makeService(storage: unknown) {
    const scans = { create: vi.fn().mockResolvedValue({ id: 's1' }) };
    const businesses = { consumeScan: vi.fn().mockResolvedValue(undefined) };
    const service = new InvoiceScanService(
      scans as never,
      {} as never,
      {} as never,
      storage as never,
      businesses as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, scans, businesses };
  }

  it('sin almacenamiento configurado responde 503 y NO consume cuota', async () => {
    // El servicio real, con la variable ausente: mismo camino que en producción.
    const storage = new StorageService({
      get: () => undefined,
    } as never);
    const { service, scans, businesses } = makeService(storage);

    await expect(
      TenantContext.run(ctx, () => service.upload(file, user)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(businesses.consumeScan).not.toHaveBeenCalled();
    expect(scans.create).not.toHaveBeenCalled();
  });

  it('con almacenamiento configurado sí consume cuota y crea la factura', async () => {
    const storage = {
      assertAvailable: vi.fn(),
      uploadPrivado: vi.fn().mockResolvedValue({ pathname: 'facturas/b1/f.jpg' }),
    };
    const { service, scans, businesses } = makeService(storage);

    await TenantContext.run(ctx, () => service.upload(file, user));

    expect(businesses.consumeScan).toHaveBeenCalledOnce();
    expect(storage.uploadPrivado).toHaveBeenCalledOnce();
    expect(scans.create).toHaveBeenCalledOnce();
  });

  it("rechaza por contenido un HTML con mimetype image/png, sin cobrar ni subir", async () => {
    const storage = { assertAvailable: vi.fn(), uploadPrivado: vi.fn() };
    const { service, scans, businesses } = makeService(storage);
    const html = { ...file, buffer: Buffer.from("<html><script>x</script></html>"), mimetype: "image/png" };

    await expect(
      TenantContext.run(ctx, () => service.upload(html, user)),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(businesses.consumeScan).not.toHaveBeenCalled();
    expect(storage.uploadPrivado).not.toHaveBeenCalled();
    expect(scans.create).not.toHaveBeenCalled();
  });

  it("guarda con el Content-Type detectado, no con el declarado", async () => {
    const storage = {
      assertAvailable: vi.fn(),
      uploadPrivado: vi.fn().mockResolvedValue({ pathname: "p" }),
    };
    const { service } = makeService(storage);
    const png = { ...file, buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mimetype: "image/jpeg" };

    await TenantContext.run(ctx, () => service.upload(png, user));

    expect(storage.uploadPrivado.mock.calls[0]![0]).toMatch(/.png$/);
    expect(storage.uploadPrivado.mock.calls[0]![2]).toBe("image/png");
  });
});
