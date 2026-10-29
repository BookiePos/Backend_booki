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

import { CustomersService } from './customers.service';

/** El DV del NIT se valida al crear y al editar, con el campo a corregir. */
describe('CustomersService: DV del NIT', () => {
  const build = () => {
    const model: any = { create: vi.fn(async (d: any) => d) };
    return { model, service: new CustomersService(model) };
  };

  it('rechaza un DV que no cuadra y dice qué campo corregir', async () => {
    const { service, model } = build();
    await expect(
      service.create({
        name: 'Banco',
        docNumber: '860002964',
        dianDocType: '31',
        nitDv: '9',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('acepta el DV correcto y guarda los datos fiscales', async () => {
    const { service, model } = build();
    await service.create({
      name: 'Banco',
      docNumber: '860002964',
      dianDocType: '31',
      nitDv: '4',
      tipoPersona: '1',
      municipioDane: '11001',
    });
    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({ dianDocType: '31', nitDv: '4', municipioDane: '11001' }),
    );
  });

  it('edición: cambiar el DV a uno malo se rechaza', async () => {
    const { service, model } = build();
    const doc: any = {
      docType: 'NIT',
      docNumber: '860002964',
      dianDocType: '31',
      nitDv: '4',
      save: vi.fn(),
    };
    model.findById = vi.fn(() => ({ exec: async () => doc }));
    await expect(service.update('x', { nitDv: '1' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('edición: un cliente viejo con DV mal en el número puede cambiar el teléfono', async () => {
    const { service, model } = build();
    const doc: any = {
      docType: 'NIT',
      docNumber: '860002964-9',
      save: vi.fn(),
    };
    model.findById = vi.fn(() => ({ exec: async () => doc }));
    await expect(service.update('x', { phone: '300' })).resolves.toBeDefined();
  });
});
