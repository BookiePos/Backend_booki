import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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

import { SalesService } from './sales.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * La anulación con su nota de anulación (concepto 2, Fase 6B): la nota se
 * emite después del flip y del fiado y ANTES de revertir stock y libro; si
 * falla, la venta vuelve a como estaba. La transmisión va detrás.
 */
describe('SalesService.void · nota de anulación (Fase 6B)', () => {
  const sedeId = new Types.ObjectId();
  const saleObjId = new Types.ObjectId();
  const user = { userId: 'u1', email: 'c@erp.local', sedeIds: [sedeId.toString()], permissions: [] } as unknown as JwtUser;

  const saleDoc = () => ({
    _id: saleObjId,
    id: saleObjId.toString(),
    saleNumber: 'FV-000050',
    status: 'completed',
    sedeId: { _id: sedeId },
    payment: { method: 'card' },
    total: 10_000,
    tip: 1_000,
    components: [{ productId: new Types.ObjectId(), qty: 1, consumedLots: [] }],
    lines: [],
  });

  let saleModel: any;
  let stock: any;
  let ledgerPosting: any;
  let treasury: any;
  let notas: any;
  let orden: string[];
  let service: SalesService;

  beforeEach(() => {
    orden = [];
    saleModel = {
      findById: vi.fn().mockReturnValue({ populate: () => ({ exec: () => Promise.resolve(saleDoc()) }) }),
      findOneAndUpdate: vi.fn().mockReturnValue({ exec: () => Promise.resolve(saleDoc()) }),
      updateOne: vi.fn(() => ({ exec: async () => ({}) })),
    };
    stock = { reverseSale: vi.fn(async () => void orden.push('stock')) };
    ledgerPosting = { reverseSale: vi.fn(async () => void orden.push('libro')) };
    treasury = { reverse: vi.fn(async () => undefined) };
    notas = {
      emitir: vi.fn(async () => {
        orden.push('nota');
        return { estado: 'emitida', documentoId: 'n1', fullNumber: 'NC7', concepto: '2', referenceType: 'invoice' };
      }),
      transmitirDetras: vi.fn(() => void orden.push('transmitir')),
    };
    const cajaSessionModel = {
      findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
      findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
    };
    const receivableModel = {
      findOneAndUpdate: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
      findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
    };
    const saleReturnModel = { countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }) };
    service = new SalesService(
      saleModel,
      {} as any,
      {} as any,
      cajaSessionModel as any,
      {} as any,
      receivableModel as any,
      stock,
      {} as any,
      {} as any,
      {} as any,
      { rulesFor: async () => null } as any,
      { refFor: async () => null } as any,
      {} as any,
      { cancelSaleDeduction: vi.fn() } as any,
      {} as any,
      ledgerPosting,
      treasury,
      {} as any,
      {} as any,
      {} as any,
      saleReturnModel as any,
      { create: vi.fn() } as any,
      notas,
    );
  });

  it('emite la nota concepto 2 antes de revertir stock y libro, y la transmite al final', async () => {
    await service.void(saleObjId.toString(), user, { motivo: 'Error de digitación' });
    expect(orden).toEqual(['nota', 'stock', 'libro', 'transmitir']);
    const [, s] = notas.emitir.mock.calls[0];
    expect(s).toEqual({ origen: `anulacion:${saleObjId}`, concepto: '2', motivo: 'Error de digitación' });
    expect(saleModel.updateOne).toHaveBeenCalledWith(
      { _id: saleObjId },
      { $set: { notaAnulacion: expect.objectContaining({ estado: 'emitida', fullNumber: 'NC7' }) } },
    );
  });

  describe('ventana del POS (decisión 6: misma semana calendario)', () => {
    const conPos = (fecha: Date) => ({
      ...saleDoc(),
      soldAt: fecha,
      documentoFiscal: { solicitado: 'pos_anonimo', estado: 'emitido', tipo: 'pos' },
    });

    it('un POS de una semana anterior no se anula: 400 que manda a la devolución, sin tocar nada', async () => {
      saleModel.findById.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(conPos(new Date('2026-01-05T15:00:00Z'))) }),
      });
      await expect(service.void(saleObjId.toString(), user)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Registra una devolución'),
      });
      expect(saleModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(notas.emitir).not.toHaveBeenCalled();
      expect(stock.reverseSale).not.toHaveBeenCalled();
    });

    it('un POS de esta misma semana sí se anula, con su nota', async () => {
      saleModel.findById.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(conPos(new Date())) }),
      });
      await service.void(saleObjId.toString(), user);
      expect(notas.emitir).toHaveBeenCalled();
    });

    it('una venta vieja SIN POS (FEV o sin documento) se sigue anulando', async () => {
      saleModel.findById.mockReturnValue({
        populate: () => ({
          exec: () =>
            Promise.resolve({
              ...saleDoc(),
              soldAt: new Date('2026-01-05T15:00:00Z'),
              documentoFiscal: { solicitado: 'fev', estado: 'emitido', tipo: 'invoice' },
            }),
        }),
      });
      await service.void(saleObjId.toString(), user);
      expect(notas.emitir).toHaveBeenCalled();
    });
  });

  it('sin motivo usa uno por defecto con el número de la venta', async () => {
    await service.void(saleObjId.toString(), user);
    expect(notas.emitir.mock.calls[0][1].motivo).toBe('Anulación de la venta FV-000050');
  });

  it('si la nota falla, deshace el flip y no revierte nada', async () => {
    notas.emitir.mockRejectedValue(new BadRequestException('sin PIN'));
    await expect(service.void(saleObjId.toString(), user)).rejects.toBeInstanceOf(BadRequestException);
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(ledgerPosting.reverseSale).not.toHaveBeenCalled();
    expect(treasury.reverse).not.toHaveBeenCalled();
    // El flip vuelve a 'completed'.
    expect(saleModel.updateOne).toHaveBeenCalledWith(
      { _id: saleObjId, status: 'void' },
      { $set: { status: 'completed' } },
    );
    expect(notas.transmitirDetras).not.toHaveBeenCalled();
  });

  it('venta sin documento: se anula igual y queda dicho que no lleva nota', async () => {
    notas.emitir.mockResolvedValue({ estado: 'sin_nota', motivo: 'La venta no tiene documento electrónico' });
    await service.void(saleObjId.toString(), user);
    expect(stock.reverseSale).toHaveBeenCalledTimes(1);
    expect(saleModel.updateOne).toHaveBeenCalledWith(
      { _id: saleObjId },
      { $set: { notaAnulacion: { estado: 'sin_nota', motivo: 'La venta no tiene documento electrónico' } } },
    );
  });
});
