import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
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

import { StockService } from './stock.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Devolución de stock al anular una venta.
 *
 * Anular tiene que dejar el inventario exactamente como estaba, y eso incluye
 * el LOTE del que salió cada unidad, no solo la cantidad total. Si la mercancía
 * volviera a un lote cualquiera, la cantidad consolidada cuadraría —así que
 * nadie lo notaría— pero el vencimiento y el costo quedarían asignados al lote
 * equivocado: se vendería como fresco algo que está por vencerse, y el margen de
 * la siguiente venta saldría con el costo de otro lote.
 *
 * `sales.service.void.spec.ts` ya comprueba que la reversa se llama UNA vez.
 * Aquí se comprueba qué hace esa reversa.
 */
describe('StockService.reverseSale · devolución por anulación', () => {
  const sedeId = new Types.ObjectId();
  const productId = new Types.ObjectId();
  const loteA = new Types.ObjectId();
  const loteB = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let stockItemModel: any;
  let lotModel: any;
  let movementModel: any;
  let service: StockService;

  /** Existencia consolidada resultante del $inc de la devolución. */
  function build(qtyTrasDevolucion: number) {
    stockItemModel = {
      findOneAndUpdate: vi.fn(() => ({
        exec: () => Promise.resolve({ qty: qtyTrasDevolucion }),
      })),
    };
    lotModel = { updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })) };
    movementModel = { create: vi.fn((docs: unknown[]) => Promise.resolve(docs)) };

    service = new StockService(
      stockItemModel as never,
      lotModel as never,
      movementModel as never,
      { connectionFor: () => ({ transaction: (cb: any) => cb(undefined) }) } as never,
      {
        getOrFail: vi.fn().mockResolvedValue({ _id: productId, name: 'Harina' }),
      } as never,
      { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  /** Movimientos de kardex escritos, aplanados. */
  function kardex(): any[] {
    return movementModel.create.mock.calls.flatMap((c: any[]) => c[0]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('devuelve cada porción a SU lote, no todo al primero', async () => {
    build(25);

    await service.reverseSale(
      sedeId.toString(),
      [
        {
          productId: productId.toString(),
          qty: 25,
          consumedLots: [
            { lotId: loteA.toString(), qty: 10, unitCost: 3_000 },
            { lotId: loteB.toString(), qty: 15, unitCost: 3_200 },
          ],
        },
      ],
      user,
    );

    expect(lotModel.updateOne).toHaveBeenCalledTimes(2);
    const [primera, segunda] = lotModel.updateOne.mock.calls;
    expect(primera[0]._id.toString()).toBe(loteA.toString());
    expect(primera[1]).toEqual({ $inc: { qty: 10 } });
    expect(segunda[0]._id.toString()).toBe(loteB.toString());
    expect(segunda[1]).toEqual({ $inc: { qty: 15 } });
  });

  it('repone la cantidad total en la existencia consolidada', async () => {
    build(25);

    await service.reverseSale(
      sedeId.toString(),
      [
        {
          productId: productId.toString(),
          qty: 25,
          consumedLots: [{ lotId: loteA.toString(), qty: 25, unitCost: 3_000 }],
        },
      ],
      user,
    );

    expect(stockItemModel.findOneAndUpdate.mock.calls[0][1]).toEqual({
      $inc: { qty: 25 },
    });
  });

  it('conserva el costo original de cada lote en el kardex', async () => {
    build(25);

    await service.reverseSale(
      sedeId.toString(),
      [
        {
          productId: productId.toString(),
          qty: 25,
          consumedLots: [
            { lotId: loteA.toString(), qty: 10, unitCost: 3_000 },
            { lotId: loteB.toString(), qty: 15, unitCost: 3_200 },
          ],
        },
      ],
      user,
    );

    const movs = kardex();
    expect(movs.map((m) => m.unitCost)).toEqual([3_000, 3_200]);
    expect(movs.map((m) => m.delta)).toEqual([10, 15]);
    expect(movs.every((m) => m.type === 'sale_void')).toBe(true);
  });

  it('el saldo del kardex sube porción a porción hasta la existencia final', async () => {
    build(25); // había 0, se devuelven 25

    await service.reverseSale(
      sedeId.toString(),
      [
        {
          productId: productId.toString(),
          qty: 25,
          consumedLots: [
            { lotId: loteA.toString(), qty: 10, unitCost: 3_000 },
            { lotId: loteB.toString(), qty: 15, unitCost: 3_200 },
          ],
        },
      ],
      user,
    );

    // 0 → 10 → 25: el último saldo coincide con la existencia consolidada.
    expect(kardex().map((m) => m.balanceAfter)).toEqual([10, 25]);
  });

  it('un producto sin lotes se devuelve en una sola porción', async () => {
    build(7);

    await service.reverseSale(
      sedeId.toString(),
      [{ productId: productId.toString(), qty: 7, consumedLots: [] }],
      user,
    );

    expect(lotModel.updateOne).not.toHaveBeenCalled();
    const movs = kardex();
    expect(movs).toHaveLength(1);
    expect(movs[0].delta).toBe(7);
    expect(movs[0].lotId).toBeUndefined();
  });

  it('devuelve todas las líneas de la venta, no solo la primera', async () => {
    build(10);
    const otroProducto = new Types.ObjectId();

    await service.reverseSale(
      sedeId.toString(),
      [
        {
          productId: productId.toString(),
          qty: 5,
          consumedLots: [{ lotId: loteA.toString(), qty: 5, unitCost: 3_000 }],
        },
        {
          productId: otroProducto.toString(),
          qty: 5,
          consumedLots: [{ lotId: loteB.toString(), qty: 5, unitCost: 1_000 }],
        },
      ],
      user,
    );

    expect(stockItemModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(kardex()).toHaveLength(2);
  });

  it('crea la existencia si el producto ya no la tenía en esa sede', async () => {
    build(5);

    await service.reverseSale(
      sedeId.toString(),
      [{ productId: productId.toString(), qty: 5, consumedLots: [] }],
      user,
    );

    // upsert: si la fila se borró entre la venta y la anulación, la devolución
    // no puede perderse en silencio.
    expect(stockItemModel.findOneAndUpdate.mock.calls[0][2]).toMatchObject({
      upsert: true,
    });
  });
});
