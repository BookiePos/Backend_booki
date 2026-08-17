import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata de tipo para los @Prop() con uniones de
// literales, y @nestjs/mongoose lanza al no poder inferir el tipo cuando se
// importan los esquemas. Estos tests no usan los esquemas reales (modelos
// mockeados): neutralizamos decoradores/SchemaFactory para importar el servicio.
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

import { SalesService } from './sales.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Comportamiento de la anulación atómica en SalesService.void.
 * Se instancia el servicio DIRECTAMENTE con dependencias mockeadas. Solo se
 * mockean los colaboradores que ESTE método toca (saleModel, stock, ledger,
 * treasury); el resto son placeholders.
 *
 * Constructor (orden):
 *   saleModel, counterModel, stockItemModel, cajaSessionModel, discountModel,
 *   receivableModel, stock, products, sedes, catalog, customers, payroll,
 *   params, ledgerPosting, treasury
 */
describe('SalesService.void (anulación atómica)', () => {
  const sedeId = new Types.ObjectId();
  const saleObjId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@erp.local',
    name: 'Cajero',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  // Venta devuelta por getOrFail (findById...populate...exec). sedeId "populado".
  function saleDoc() {
    return {
      _id: saleObjId,
      id: saleObjId.toString(),
      status: 'completed',
      sedeId: { _id: sedeId, code: 'S1', name: 'Sede 1' },
      components: [
        {
          productId: new Types.ObjectId(),
          qty: 3,
          consumedLots: [
            { lotId: new Types.ObjectId(), qty: 3, unitCost: 100 },
          ],
        },
      ],
      lines: [],
    };
  }

  let saleModel: any;
  let stock: any;
  let ledgerPosting: any;
  let treasury: any;
  let service: SalesService;

  beforeEach(() => {
    saleModel = {
      findById: vi.fn().mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(saleDoc()) }),
      }),
      findOneAndUpdate: vi
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve(saleDoc()) }),
    };
    stock = { reverseSale: vi.fn().mockResolvedValue(undefined) };
    ledgerPosting = { reverseSale: vi.fn().mockResolvedValue(undefined) };
    treasury = { reverse: vi.fn().mockResolvedValue(undefined) };

    service = new SalesService(
      saleModel, // saleModel
      {} as any, // counterModel
      {} as any, // stockItemModel
      {} as any, // cajaSessionModel
      {} as any, // discountModel
      {} as any, // receivableModel
      stock, // stock
      {} as any, // products
      {} as any, // sedes
      {} as any, // catalog
      {} as any, // customers
      {} as any, // payroll
      {} as any, // params
      ledgerPosting, // ledgerPosting
      treasury, // treasury
    );
  });

  it('lanza y NO revierte stock si el flip status!=void devuelve null (ya anulada)', async () => {
    saleModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(null),
    });

    await expect(service.void(saleObjId.toString(), user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(ledgerPosting.reverseSale).not.toHaveBeenCalled();
    expect(treasury.reverse).not.toHaveBeenCalled();
  });

  it('camino feliz: flip exitoso → revierte el stock una sola vez', async () => {
    await service.void(saleObjId.toString(), user);

    expect(stock.reverseSale).toHaveBeenCalledTimes(1);
    const [calledSede] = stock.reverseSale.mock.calls[0];
    expect(calledSede).toBe(sedeId.toString());
    // Los pasos contables/tesorería también corren una sola vez.
    expect(ledgerPosting.reverseSale).toHaveBeenCalledTimes(1);
    expect(treasury.reverse).toHaveBeenCalledTimes(1);
  });
});
