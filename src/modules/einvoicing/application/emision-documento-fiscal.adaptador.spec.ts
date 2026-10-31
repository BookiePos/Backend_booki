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

import { EmisionDocumentoFiscalDian } from './emision-documento-fiscal.adaptador';

describe('EmisionDocumentoFiscalDian', () => {
  const user = { email: 'c@x.co' } as never;
  const doc = (type: string) => ({
    _id: 'd1',
    type,
    fullNumber: 'X1',
    cufe: 'cude',
    qrUrl: 'qr',
    dianStatus: 'draft',
  });

  function build() {
    const einvoicing = {
      createPosFromSale: vi.fn(async () => doc('pos')),
      createFromSale: vi.fn(async () => doc('invoice')),
    };
    const transmision = { transmitir: vi.fn(async () => ({})) };
    return { einvoicing, transmision, a: new EmisionDocumentoFiscalDian(einvoicing as never, transmision as never) };
  }

  it('pos_anonimo y pos_identificado van al POS con su modo; fev a la factura', async () => {
    const { einvoicing, a } = build();
    await a.emitir('s1', 'pos_anonimo', user);
    await a.emitir('s1', 'pos_identificado', user);
    expect(einvoicing.createPosFromSale.mock.calls).toEqual([
      ['s1', 'anonimo', user],
      ['s1', 'identificado', user],
    ]);
    const r = await a.emitir('s1', 'fev', user);
    expect(einvoicing.createFromSale).toHaveBeenCalledWith('s1', user);
    expect(r).toEqual({ documentoId: 'd1', tipo: 'invoice', fullNumber: 'X1', cude: 'cude', qrUrl: 'qr', dianStatus: 'draft' });
  });

  it('transmitir nunca lanza', async () => {
    const { transmision, a } = build();
    transmision.transmitir.mockRejectedValue(new Error('501'));
    await expect(a.transmitir('d1', user)).resolves.toBeUndefined();
  });
});
