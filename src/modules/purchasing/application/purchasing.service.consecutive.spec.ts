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

import { PurchasingService } from './purchasing.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Consecutivo de órdenes de compra: PurchasingService.nextNumber, formato
 * `OC-000012` (prefijo fijo + seq con padStart 6, clave `purchase_order`).
 *
 * `nextNumber` es privado; se ejercita a través de `create`, verificando el
 * `number` con que se llama a orders.create. El contador $inc se mockea con
 * { seq: N }. De paso se valida el cálculo de totales de buildLines.
 *
 * Constructor (orden): (orders, payables, counterModel, stock, tax, ledgerPosting)
 */
describe('PurchasingService.nextNumber (consecutivo OC-000012)', () => {
  const sedeId = new Types.ObjectId();
  const createdId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'comprador@erp.local',
    name: 'Comprador',
    role: 'buyer',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let orders: any;
  let counterModel: any;
  let tax: any;
  let service: PurchasingService;

  function wire(seq: number) {
    orders = {
      create: vi
        .fn()
        .mockImplementation((doc: any) =>
          Promise.resolve({ ...doc, _id: createdId }),
        ),
    };
    counterModel = {
      findOneAndUpdate: vi
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve({ seq }) }),
    };
    tax = {
      // IVA 19% sobre la base del renglón.
      compute: vi
        .fn()
        .mockImplementation((_code: string, base: number) =>
          Promise.resolve({ taxAmount: Math.round(base * 0.19) }),
        ),
    };
    service = new PurchasingService(
      orders,
      {} as any, // payables
      counterModel,
      {} as any, // stock
      tax,
      {} as any, // ledgerPosting
    );
  }

  beforeEach(() => {
    wire(12);
  });

  it('formatea OC-000012 con padStart de 6', async () => {
    await service.create(
      {
        sedeId: sedeId.toString(),
        lines: [{ qty: 2, unitCost: 1_000 }],
      } as any,
      user,
    );

    expect(orders.create).toHaveBeenCalledTimes(1);
    const [doc] = orders.create.mock.calls[0];
    expect(doc.number).toBe('OC-000012');
  });

  it('usa la clave de contador `purchase_order` con $inc 1', async () => {
    await service.create(
      {
        sedeId: sedeId.toString(),
        lines: [{ qty: 1, unitCost: 500 }],
      } as any,
      user,
    );

    const [filter, update] = counterModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'purchase_order' });
    expect(update).toEqual({ $inc: { seq: 1 } });
  });

  it('buildLines: subtotal = Σ(unitCost·qty), total = subtotal + IVA de renglones', async () => {
    await service.create(
      {
        sedeId: sedeId.toString(),
        lines: [
          { qty: 2, unitCost: 1_000, taxCode: 'IVA_19' }, // sub 2000, iva 380
          { qty: 3, unitCost: 500 }, // sub 1500, sin taxCode → iva 0
        ],
      } as any,
      user,
    );

    const [doc] = orders.create.mock.calls[0];
    expect(doc.subtotal).toBe(3_500);
    expect(doc.taxAmount).toBe(380);
    expect(doc.total).toBe(3_880);
  });
});
