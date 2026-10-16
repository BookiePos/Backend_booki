import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
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

import { CustomersService } from './customers.service';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

/**
 * Ítem 4.11: la lista de precios de un cliente decide lo que se le cobra, así
 * que asignarla pide `pos.discount.authorize`, como elegirla en la venta. Un
 * cajero (customers.manage sin ese permiso) no se la puede poner.
 */
const LISTA = '64b0000000000000000000e1';
const OTRA = '64b0000000000000000000e2';
const CAJERO = [PERMISSIONS.CUSTOMERS_MANAGE, PERMISSIONS.POS_SELL];
const GERENTE = [...CAJERO, PERMISSIONS.POS_DISCOUNT_AUTHORIZE];
const BASE = { name: 'Cliente', docNumber: '123' };

describe('CustomersService · lista de precios con permiso', () => {
  let doc: any;
  let customers: any;
  let service: CustomersService;

  beforeEach(() => {
    doc = { priceListId: undefined, save: vi.fn().mockResolvedValue(undefined) };
    customers = {
      create: vi.fn((d: unknown) => Promise.resolve(d)),
      findById: vi.fn(() => ({ exec: () => Promise.resolve(doc) })),
    };
    service = new CustomersService(customers as never);
  });

  it('un cajero no crea un cliente con lista de precios', async () => {
    await expect(
      service.create({ ...BASE, priceListId: LISTA } as never, 'c@x.co', CAJERO),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(customers.create).not.toHaveBeenCalled();
  });

  it('un cajero no le asigna ni le cambia la lista a un cliente', async () => {
    await expect(
      service.update('id', { priceListId: LISTA } as never, CAJERO),
    ).rejects.toBeInstanceOf(ForbiddenException);
    doc.priceListId = new Types.ObjectId(LISTA);
    await expect(
      service.update('id', { priceListId: OTRA } as never, CAJERO),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('un cajero sí crea clientes sin lista, reenvía la misma o se la quita', async () => {
    await expect(service.create(BASE as never, 'c@x.co', CAJERO)).resolves.toBeDefined();
    doc.priceListId = new Types.ObjectId(LISTA);
    await service.update('id', { name: 'Otro', priceListId: LISTA } as never, CAJERO);
    await service.update('id', { priceListId: '' } as never, CAJERO);
    expect(doc.priceListId).toBeUndefined();
  });

  it('con pos.discount.authorize sí la asigna', async () => {
    await service.update('id', { priceListId: LISTA } as never, GERENTE);
    expect(String(doc.priceListId)).toBe(LISTA);
  });
});
