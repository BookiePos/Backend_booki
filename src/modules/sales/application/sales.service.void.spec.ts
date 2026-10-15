import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
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
  let receivableModel: any;
  let payroll: any;
  let saleReturnModel: any;
  let stock: any;
  let ledgerPosting: any;
  let treasury: any;
  let cajaSessionModel: any;
  let cajaMovementModel: any;
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
    // Sin CxC, sin consumo de empleado y sin devoluciones: venta de contado.
    receivableModel = {
      findOneAndUpdate: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
      findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
    };
    payroll = { cancelSaleDeduction: vi.fn().mockResolvedValue(undefined) };
    saleReturnModel = {
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
    };
    stock = { reverseSale: vi.fn().mockResolvedValue(undefined) };
    ledgerPosting = { reverseSale: vi.fn().mockResolvedValue(undefined) };
    treasury = { reverse: vi.fn().mockResolvedValue(undefined) };
    cajaSessionModel = {
      findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
      findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
    };
    cajaMovementModel = { create: vi.fn().mockResolvedValue({}) };

    service = new SalesService(
      saleModel, // saleModel
      {} as any, // counterModel
      {} as any, // stockItemModel
      cajaSessionModel, // cajaSessionModel
      {} as any, // discountModel
      receivableModel, // receivableModel
      stock, // stock
      {} as any, // products
      {} as any, // sedes
      {} as any, // catalog
      // Sin lista de precios: se cobra el precio de mostrador del catálogo.
      { rulesFor: async () => null } as any, // priceLists
      // Sin domicilio: no hay zona que resolver.
      { refFor: async () => null } as any, // deliveryZones
      {} as any, // customers
      payroll, // payroll
      {} as any, // params
      ledgerPosting, // ledgerPosting
      treasury, // treasury
      {} as any, // sedeModel: solo lo recibe populate, que aquí está simulado
      {} as any, // tax: sin tenant restaurante no se consulta el INC
      {} as any, // businesses: el giro viene en el contexto o no hay tenant
      saleReturnModel, // saleReturnModel
      cajaMovementModel, // cajaMovementModel
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

  // ── 1.6 Anular un fiado ────────────────────────────────────────────────────

  /** Venta a crédito (fiado): mismo documento con `payment.method = 'credit'`. */
  function fiado() {
    return { ...saleDoc(), payment: { method: 'credit' } };
  }

  function comoFiado() {
    saleModel.findById.mockReturnValue({
      populate: () => ({ exec: () => Promise.resolve(fiado()) }),
    });
    saleModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(fiado()),
    });
    saleModel.updateOne = vi
      .fn()
      .mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) });
  }

  it('fiado a cliente sin abonos: anula la CxC (solo si sigue sin abonos) y revierte', async () => {
    comoFiado();
    receivableModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve({ _id: new Types.ObjectId(), status: 'void' }),
    });

    await service.void(saleObjId.toString(), user);

    expect(receivableModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filtro, cambio] = receivableModel.findOneAndUpdate.mock.calls[0];
    expect(filtro).toMatchObject({ saleId: saleObjId, paidAmount: 0 });
    expect(cambio).toEqual({ $set: { status: 'void' } });
    // El fiado era de un cliente: la nómina no tiene nada que ver.
    expect(payroll.cancelSaleDeduction).not.toHaveBeenCalled();
    expect(stock.reverseSale).toHaveBeenCalledTimes(1);
    expect(ledgerPosting.reverseSale).toHaveBeenCalledTimes(1);
  });

  it('fiado a cliente CON abonos: rechaza, deshace el flip y no toca stock ni libro', async () => {
    comoFiado();
    // El flip condicional (paidAmount 0) no encuentra nada: la CxC tiene abonos.
    receivableModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({ status: 'partial', amount: 20_000, paidAmount: 5_000 }),
    });

    await expect(
      service.void(saleObjId.toString(), user),
    ).rejects.toBeInstanceOf(BadRequestException);

    // La venta vuelve a 'completed': la anulación no ocurrió.
    expect(saleModel.updateOne).toHaveBeenCalledWith(
      { _id: saleObjId, status: 'void' },
      { $set: { status: 'completed' } },
    );
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(ledgerPosting.reverseSale).not.toHaveBeenCalled();
    expect(treasury.reverse).not.toHaveBeenCalled();
  });

  it('fiado de empleado ya descontado en nómina: rechaza y deshace el flip', async () => {
    comoFiado();
    payroll.cancelSaleDeduction.mockRejectedValue(
      new BadRequestException('ya se descontó'),
    );

    await expect(
      service.void(saleObjId.toString(), user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(saleModel.updateOne).toHaveBeenCalledTimes(1);
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(ledgerPosting.reverseSale).not.toHaveBeenCalled();
  });

  it('fiado de empleado (sin CxC): cancela el consumo en nómina y revierte', async () => {
    comoFiado();

    await service.void(saleObjId.toString(), user);

    expect(payroll.cancelSaleDeduction).toHaveBeenCalledWith(
      saleObjId.toString(),
    );
    expect(stock.reverseSale).toHaveBeenCalledTimes(1);
  });

  it('fiado a cliente: si falla la reversa de stock, la CxC vuelve a open y la venta a completed', async () => {
    comoFiado();
    receivableModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve({ _id: new Types.ObjectId(), status: 'void' }),
    });
    receivableModel.updateOne = vi
      .fn()
      .mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) });
    stock.reverseSale.mockRejectedValue(new Error('producto borrado'));

    await expect(service.void(saleObjId.toString(), user)).rejects.toThrow(
      'producto borrado',
    );

    // Se deshace solo lo que esta anulación anuló, y solo si sigue sin abonos.
    expect(receivableModel.updateOne).toHaveBeenCalledWith(
      { saleId: saleObjId, status: 'void', paidAmount: 0 },
      { $set: { status: 'open' } },
    );
    expect(saleModel.updateOne).toHaveBeenCalledWith(
      { _id: saleObjId, status: 'void' },
      { $set: { status: 'completed' } },
    );
    // El reintento puede volver a anular: no quedó nada a medias en el libro.
    expect(ledgerPosting.reverseSale).not.toHaveBeenCalled();
    expect(treasury.reverse).not.toHaveBeenCalled();
  });

  it('fiado de empleado: si falla la reversa de stock, el consumo vuelve a nómina', async () => {
    comoFiado();
    payroll.restoreSaleDeduction = vi.fn().mockResolvedValue(undefined);
    stock.reverseSale.mockRejectedValue(new Error('sin conexión'));

    await expect(service.void(saleObjId.toString(), user)).rejects.toThrow(
      'sin conexión',
    );

    expect(payroll.restoreSaleDeduction).toHaveBeenCalledWith(
      saleObjId.toString(),
    );
    expect(saleModel.updateOne).toHaveBeenCalledTimes(1);
    expect(ledgerPosting.reverseSale).not.toHaveBeenCalled();
  });

  it('venta de contado: si falla la reversa de stock, la venta vuelve a completed', async () => {
    saleModel.updateOne = vi
      .fn()
      .mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) });
    stock.reverseSale.mockRejectedValue(new Error('boom'));

    await expect(service.void(saleObjId.toString(), user)).rejects.toThrow(
      'boom',
    );
    expect(saleModel.updateOne).toHaveBeenCalledWith(
      { _id: saleObjId, status: 'void' },
      { $set: { status: 'completed' } },
    );
    expect(ledgerPosting.reverseSale).not.toHaveBeenCalled();
  });

  it('venta de contado no toca CxC ni nómina', async () => {
    await service.void(saleObjId.toString(), user);
    expect(receivableModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(payroll.cancelSaleDeduction).not.toHaveBeenCalled();
  });

  // ── 1.7 Anular con devoluciones previas ────────────────────────────────────

  it('venta con devoluciones previas: rechaza ANTES del flip (no revierte de más)', async () => {
    saleReturnModel.countDocuments.mockReturnValue({
      exec: () => Promise.resolve(1),
    });

    await expect(
      service.void(saleObjId.toString(), user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(saleReturnModel.countDocuments).toHaveBeenCalledWith({
      saleId: saleObjId,
    });
    expect(saleModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(ledgerPosting.reverseSale).not.toHaveBeenCalled();
  });

  it('devolución que entra entre la revisión y el flip: deshace el flip y no revierte nada', async () => {
    saleModel.updateOne = vi
      .fn()
      .mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) });
    // Primera cuenta (antes del flip): 0. Segunda (después): ya hay una.
    saleReturnModel.countDocuments
      .mockReturnValueOnce({ exec: () => Promise.resolve(0) })
      .mockReturnValueOnce({ exec: () => Promise.resolve(1) });

    await expect(
      service.void(saleObjId.toString(), user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(saleModel.updateOne).toHaveBeenCalledWith(
      { _id: saleObjId, status: 'void' },
      { $set: { status: 'completed' } },
    );
    expect(receivableModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(ledgerPosting.reverseSale).not.toHaveBeenCalled();
  });

  // ── 1.12 Anular una venta de un turno cerrado ──────────────────────────────

  describe('venta en efectivo de un turno ya cerrado (ítem 1.12)', () => {
    const turnoCerrado = new Types.ObjectId();
    const turnoAbierto = new Types.ObjectId();

    function enEfectivo(cajaSessionId: Types.ObjectId) {
      const doc = () => ({
        ...saleDoc(),
        saleNumber: 'FV-000042',
        payment: { method: 'cash' },
        cajaSessionId,
        total: 50_000,
        tip: 5_000,
        deliveryFee: 4_000,
      });
      saleModel.findById.mockReturnValue({
        populate: () => ({ exec: () => Promise.resolve(doc()) }),
      });
      saleModel.findOneAndUpdate.mockReturnValue({
        exec: () => Promise.resolve(doc()),
      });
    }

    it('registra la salida del efectivo en la caja abierta de la sede', async () => {
      enEfectivo(turnoCerrado);
      cajaSessionModel.findById.mockReturnValue({
        exec: () => Promise.resolve({ _id: turnoCerrado, status: 'closed' }),
      });
      cajaSessionModel.findOne.mockReturnValue({
        exec: () => Promise.resolve({ _id: turnoAbierto, status: 'open' }),
      });

      await service.void(saleObjId.toString(), user);

      expect(cajaMovementModel.create).toHaveBeenCalledTimes(1);
      expect(cajaMovementModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: turnoAbierto,
          type: 'out',
          // Lo que el cliente pagó: total + propina + domicilio.
          amount: 59_000,
        }),
      );
    });

    it('sin caja abierta rechaza antes de anular: no toca la venta ni el stock', async () => {
      enEfectivo(turnoCerrado);
      cajaSessionModel.findById.mockReturnValue({
        exec: () => Promise.resolve({ _id: turnoCerrado, status: 'closed' }),
      });

      await expect(service.void(saleObjId.toString(), user)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(saleModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(stock.reverseSale).not.toHaveBeenCalled();
      expect(cajaMovementModel.create).not.toHaveBeenCalled();
    });

    it('venta del turno que sigue abierto: el arqueo ya la excluye, no hay movimiento', async () => {
      enEfectivo(turnoAbierto);
      cajaSessionModel.findById.mockReturnValue({
        exec: () => Promise.resolve({ _id: turnoAbierto, status: 'open' }),
      });

      await service.void(saleObjId.toString(), user);

      expect(cajaMovementModel.create).not.toHaveBeenCalled();
    });
  });
});
