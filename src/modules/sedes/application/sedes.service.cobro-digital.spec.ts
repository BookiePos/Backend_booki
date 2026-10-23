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

import { SedesService } from './sedes.service';

const b64 = (bytes: number[], total = 100) =>
  Buffer.from([...bytes, ...new Array(Math.max(0, total - bytes.length)).fill(1)]).toString('base64');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Ítem 6.4: el QR se valida por contenido, no por lo que declara el cliente. */
describe('SedesService.update · cobroDigital.qrImagen', () => {
  function build() {
    const sede: any = { code: 'A', set: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
    const model: any = { findById: vi.fn(() => ({ exec: () => Promise.resolve(sede) })) };
    const id = '68b0f3c2a1d4e5f6a7b8c9d0';
    return { service: new SedesService(model as never), sede, id };
  }

  it('acepta un PNG real y marca que la sede tiene imagen', async () => {
    const { service, sede, id } = build();
    await service.update(id, { cobroDigital: { qrImagen: `data:image/png;base64,${b64(PNG)}` } } as never);
    const [, valor] = sede.set.mock.calls.find((c: any[]) => c[0] === 'cobroDigital')!;
    expect(valor.conImagen).toBe(true);
  });

  it('rechaza un HTML que se declara image/png', async () => {
    const { service, id } = build();
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    await expect(
      service.update(id, { cobroDigital: { qrImagen: `data:image/png;base64,${html}` } } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza una imagen de más de 70 KB con un mensaje claro', async () => {
    const { service, id } = build();
    await expect(
      service.update(id, {
        cobroDigital: { qrImagen: `data:image/png;base64,${b64(PNG, 70_001)}` },
      } as never),
    ).rejects.toThrow(/70 KB/);
  });

  it('sin imagen, conImagen queda en falso', async () => {
    const { service, sede, id } = build();
    await service.update(id, { cobroDigital: { qrLlave: '@negocio' } } as never);
    const [, valor] = sede.set.mock.calls.find((c: any[]) => c[0] === 'cobroDigital')!;
    expect(valor.conImagen).toBe(false);
  });
});
