import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata de tipo para los @Prop() con uniones de
// literales, y @nestjs/mongoose lanza al no poder inferir el tipo cuando se
// importan los esquemas. Los modelos van mockeados: neutralizamos los
// decoradores/SchemaFactory para poder importar el servicio.
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

import { OrdersService } from './orders.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Consecutivo de cuentas del POS: OrdersService.nextOrderNumber, formato
 * `SEDE-C-000012` (código de sede + '-C-' + seq con padStart 6).
 *
 * `nextOrderNumber` es privado; se ejercita a través de `open`, verificando el
 * `orderNumber` con que se llama a orderModel.create. El contador $inc se
 * mockea devolviendo { seq: N }.
 *
 * Constructor (orden): (orderModel, counterModel, cajaSessionModel, sedes, catalog, sales)
 */
describe('OrdersService.nextOrderNumber (consecutivo SEDE-C-000012)', () => {
  const sedeId = new Types.ObjectId();
  const createdId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@erp.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let orderModel: any;
  let counterModel: any;
  let cajaSessionModel: any;
  let sedes: any;
  let service: OrdersService;

  function wire(seq: number, sedeCode: string) {
    orderModel = {
      create: vi
        .fn()
        .mockImplementation((doc: any) =>
          Promise.resolve({ ...doc, _id: createdId, id: createdId.toString() }),
        ),
      // getOrFail al final de open() vuelve a leer la cuenta creada.
      findById: vi.fn().mockReturnValue({
        populate: () => ({
          exec: () =>
            Promise.resolve({ _id: createdId, id: createdId.toString() }),
        }),
      }),
    };
    counterModel = {
      findOneAndUpdate: vi
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve({ seq }) }),
    };
    cajaSessionModel = {
      // assertCajaOpen: hay caja abierta.
      findOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ _id: new Types.ObjectId() }),
      }),
    };
    sedes = {
      findOrFail: vi
        .fn()
        .mockResolvedValue({ _id: sedeId, code: sedeCode, name: 'Sede' }),
    };
    service = new OrdersService(
      orderModel,
      counterModel,
      cajaSessionModel,
      sedes,
      {} as any, // catalog (sin líneas → no se usa)
      {} as any, // sales
    );
  }

  beforeEach(() => {
    wire(12, 'S1');
  });

  it('formatea SEDE-C-000012 con padStart de 6 y sede en mayúsculas', async () => {
    await service.open({ sedeId: sedeId.toString() } as any, user);

    expect(orderModel.create).toHaveBeenCalledTimes(1);
    const [doc] = orderModel.create.mock.calls[0];
    expect(doc.orderNumber).toBe('S1-C-000012');
  });

  it('pasa el _id de la clave del contador por sede y hace $inc de 1', async () => {
    await service.open({ sedeId: sedeId.toString() } as any, user);

    const [filter, update] = counterModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: `order:${sedeId.toString()}` });
    expect(update).toEqual({ $inc: { seq: 1 } });
  });

  it('con seq grande no trunca ni recorta: SEDE-C-1234567', async () => {
    wire(1_234_567, 'centro');
    await service.open({ sedeId: sedeId.toString() } as any, user);
    const [doc] = orderModel.create.mock.calls[0];
    // padStart solo rellena hasta 6; números mayores se muestran completos.
    expect(doc.orderNumber).toBe('CENTRO-C-1234567');
  });
});
