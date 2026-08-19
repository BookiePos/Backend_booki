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

import { RestaurantService } from './restaurant.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Consecutivo de comandas: RestaurantService.nextNumber, formato `CMD-000012`
 * (prefijo fijo + seq con padStart 6, clave de contador `restaurant_order`).
 *
 * `nextNumber` es privado; se ejercita a través de `openOrder`, verificando el
 * `number` con que se llama a orders.create. El contador $inc se mockea con
 * { seq: N }. resolveRates cae a los defaults del módulo cuando tax/params
 * lanzan (aquí devuelven objetos vacíos → se usan los defaults, sin romper).
 *
 * Constructor (orden): (tables, orders, counterModel, params, tax, posOrders)
 */
describe('RestaurantService.nextNumber (consecutivo CMD-000012)', () => {
  const sedeId = new Types.ObjectId();
  const tableId = new Types.ObjectId();
  const orderId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'mesero@erp.local',
    name: 'Mesero',
    role: 'waiter',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  function freeTable() {
    return {
      _id: tableId,
      sedeId,
      name: 'Mesa 1',
      zone: 'Principal',
      active: true,
      status: 'free',
      currentOrderId: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  let tables: any;
  let orders: any;
  let counterModel: any;
  let params: any;
  let tax: any;
  let service: RestaurantService;

  function wire(seq: number) {
    tables = {
      findById: vi
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve(freeTable()) }),
    };
    orders = {
      create: vi
        .fn()
        .mockImplementation((doc: any) =>
          Promise.resolve({ ...doc, _id: orderId }),
        ),
    };
    counterModel = {
      findOneAndUpdate: vi
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve({ seq }) }),
    };
    // resolveRates: devolvemos objetos sin `rate`/`value` numérico → el servicio
    // conserva los defaults del módulo. No lanza, así no ensucia el log.
    tax = { resolveRate: vi.fn().mockResolvedValue({}) };
    params = { resolve: vi.fn().mockResolvedValue({}) };
    service = new RestaurantService(
      tables,
      orders,
      counterModel,
      params,
      tax,
      {} as any, // posOrders
    );
  }

  beforeEach(() => {
    wire(12);
  });

  it('formatea CMD-000012 con padStart de 6', async () => {
    await service.openOrder({ tableId: tableId.toString() } as any, user);

    expect(orders.create).toHaveBeenCalledTimes(1);
    const [doc] = orders.create.mock.calls[0];
    expect(doc.number).toBe('CMD-000012');
  });

  it('usa la clave de contador compartida `restaurant_order` con $inc 1', async () => {
    await service.openOrder({ tableId: tableId.toString() } as any, user);

    const [filter, update] = counterModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'restaurant_order' });
    expect(update).toEqual({ $inc: { seq: 1 } });
  });

  it('rellena con ceros a la izquierda para seq de un dígito: CMD-000007', async () => {
    wire(7);
    await service.openOrder({ tableId: tableId.toString() } as any, user);
    const [doc] = orders.create.mock.calls[0];
    expect(doc.number).toBe('CMD-000007');
  });
});
