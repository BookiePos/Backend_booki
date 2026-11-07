import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';

// Se neutralizan los decoradores de esquemas (patrón de einvoicing.service.emision.spec.ts).
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

import { EinvoicingService, sinCamposInternos } from './einvoicing.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** `GET /einvoicing` y `GET /einvoicing/:id` no devuelven rutas internas del bucket. */
describe('EinvoicingService · respuesta sin campos internos', () => {
  const sedeId = new Types.ObjectId();
  const user = { email: 'a@b.co', role: 'owner', permissions: [], sedeIds: [sedeId.toString()] } as unknown as JwtUser;

  const datos = () => ({
    _id: new Types.ObjectId(),
    sedeId,
    number: 7,
    cufe: 'abc',
    total: 119000,
    dianStatus: 'accepted',
    xmlPath: 'einvoicing/b1/e1/docs/x/documento.xml',
    pdfPath: 'einvoicing/b1/e1/docs/x/documento.pdf',
    attachedPath: 'einvoicing/b1/e1/docs/x/attached.zip',
    xmlUrl: 'https://bucket/privado',
    contingencia: {
      tipo: '04',
      declaradaAt: new Date('2026-11-01'),
      xmlOriginalPath: 'einvoicing/b1/e1/docs/x/original.xml',
      enviosXml: 2,
    },
  });
  /** Documento hidratado simulado: `toObject` entrega la copia plana. */
  const hidratado = () => {
    const d = datos();
    return { ...d, toObject: () => ({ ...d, contingencia: { ...d.contingencia } }) } as never;
  };

  it('quita rutas y URL internas y deja el resto igual', () => {
    const r = sinCamposInternos(hidratado()) as Record<string, any>;
    for (const k of ['xmlPath', 'pdfPath', 'attachedPath', 'xmlUrl']) expect(r).not.toHaveProperty(k);
    expect(r.contingencia).not.toHaveProperty('xmlOriginalPath');
    expect(r.contingencia).toMatchObject({ tipo: '04', enviosXml: 2 });
    expect(r).toMatchObject({ number: 7, cufe: 'abc', total: 119000, dianStatus: 'accepted' });
  });

  it('acepta un documento sin contingencia y no muta el original', () => {
    const d = { ...datos(), contingencia: undefined };
    const r = sinCamposInternos(d as never);
    expect(r).not.toHaveProperty('xmlPath');
    const original = datos();
    sinCamposInternos(original as never);
    expect(original.xmlPath).toBeDefined();
  });

  const servicio = (docs: unknown[]) => {
    const cadena: any = {
      select: () => cadena,
      sort: () => cadena,
      limit: () => cadena,
      exec: async () => docs,
    };
    const model: any = { find: () => cadena, findById: () => ({ select: () => ({ exec: async () => docs[0] }) }) };
    return new EinvoicingService(model, {} as never, {} as never, {} as never, {} as never, {} as never);
  };

  it('get() devuelve el documento sin xmlOriginalPath ni rutas', async () => {
    const r = (await servicio([hidratado()]).get(new Types.ObjectId().toString(), user)) as Record<string, any>;
    expect(r.contingencia).not.toHaveProperty('xmlOriginalPath');
    expect(r).not.toHaveProperty('xmlPath');
    expect(r.cufe).toBe('abc');
  });

  it('list() aplica lo mismo a cada documento', async () => {
    const r = (await servicio([hidratado(), hidratado()]).list(sedeId.toString(), user)) as Record<string, any>[];
    expect(r).toHaveLength(2);
    for (const d of r) {
      expect(d).not.toHaveProperty('pdfPath');
      expect(d.contingencia).not.toHaveProperty('xmlOriginalPath');
    }
  });
});
