import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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
 * Consumo de stock por lotes (FEFO) — el primitivo que comparten la venta y la
 * producción.
 *
 * Dos cosas se juegan aquí, y ninguna avisa cuando se rompe:
 *
 * 1. El ORDEN. FEFO significa que sale primero lo que vence primero. Si el orden
 *    se invierte, la mercancía vieja se queda en bodega hasta vencerse y se tira
 *    a la basura, mientras se vendía la nueva.
 * 2. El COSTO. Cada porción consumida arrastra el `unitCost` de SU lote. De ahí
 *    salen el costo de venta y el costo del terminado de producción. Si se
 *    consumiera del lote equivocado, el margen queda mal calculado en silencio.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es:
 *   (stockItemModel, lotModel, movementModel, tenant, products, sedes,
 *    productModel, categoryModel, sedeModel)
 */
describe('StockService.consumeLines · FEFO y costo real', () => {
  const sedeId = new Types.ObjectId();
  const harinaId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'bodeguero@bookipos.local',
    name: 'Bodeguero',
    role: 'manager',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  /** Ítem de inventario que controla lotes. */
  const harina = {
    _id: harinaId,
    name: 'Harina',
    trackLots: true,
    cost: 3_000,
  };

  /** Lote de bodega: cantidad, vencimiento, recepción y costo unitario. */
  function lote(opts: {
    qty: number;
    expiresAt?: string;
    receivedAt?: string;
    unitCost: number;
  }) {
    return {
      _id: new Types.ObjectId(),
      productId: harinaId,
      sedeId,
      qty: opts.qty,
      expiresAt: opts.expiresAt ? new Date(`${opts.expiresAt}T00:00:00`) : null,
      receivedAt: new Date(`${opts.receivedAt ?? '2026-01-01'}T00:00:00`),
      unitCost: opts.unitCost,
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  let stockItemModel: any;
  let lotModel: any;
  let movementModel: any;
  let products: any;
  let service: StockService;
  /** Existencia consolidada tras el descuento (la devuelve el $inc condicional). */
  let itemTrasDescuento: { qty: number } | null;

  function build(lots: any[], product: any = harina) {
    itemTrasDescuento = { qty: 100 };
    stockItemModel = {
      findOneAndUpdate: vi.fn(() => ({
        exec: () => Promise.resolve(itemTrasDescuento),
      })),
      findOne: vi.fn(() => ({
        session: () => ({ exec: () => Promise.resolve({ qty: 2 }) }),
      })),
    };
    lotModel = {
      find: vi.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(lots) }),
      })),
      findOne: vi.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(lots[0] ?? null) }),
      })),
    };
    movementModel = {
      create: vi.fn((docs: unknown[]) => Promise.resolve(docs)),
    };
    products = { getOrFail: vi.fn().mockResolvedValue(product) };

    service = new StockService(
      stockItemModel as never,
      lotModel as never,
      movementModel as never,
      // Sin replica set el servicio corre sin sesión; se imita ese camino.
      { connectionFor: () => ({ transaction: (cb: any) => cb(undefined) }) } as never,
      products as never,
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

  it('consume primero el lote que vence antes, aunque haya entrado después', () => {
    const viejo = lote({ qty: 50, expiresAt: '2026-12-01', unitCost: 3_000 });
    const nuevo = lote({ qty: 50, expiresAt: '2026-10-01', unitCost: 3_500 });
    build([viejo, nuevo]); // llegan en orden arbitrario desde la base

    return service
      .consumeLines('sale', sedeId.toString(), [
        { productId: harinaId.toString(), qty: 10 },
      ], user)
      .then((consumed) => {
        const portions = consumed[0]!.portions;
        expect(portions).toHaveLength(1);
        expect(portions[0]!.lot).toBe(nuevo);
        expect(nuevo.qty).toBe(40);
        expect(viejo.qty).toBe(50);
      });
  });

  it('reparte entre lotes cuando el primero no alcanza, y conserva el costo de cada uno', async () => {
    const primero = lote({ qty: 10, expiresAt: '2026-10-01', unitCost: 3_000 });
    const segundo = lote({ qty: 30, expiresAt: '2026-12-01', unitCost: 3_200 });
    build([primero, segundo]);

    const consumed = await service.consumeLines(
      'production_out',
      sedeId.toString(),
      [{ productId: harinaId.toString(), qty: 25 }],
      user,
    );

    const portions = consumed[0]!.portions;
    expect(portions.map((p) => p.qty)).toEqual([10, 15]);
    expect(portions.map((p) => p.lot?.unitCost)).toEqual([3_000, 3_200]);
    // Costo real de lo consumido: 10×3.000 + 15×3.200 = 78.000.
    const costo = portions.reduce(
      (sum, p) => sum + p.qty * (p.lot?.unitCost ?? 0),
      0,
    );
    expect(costo).toBe(78_000);
    expect(primero.qty).toBe(0);
    expect(segundo.qty).toBe(15);
  });

  it('los lotes sin vencimiento van al final, y entre ellos manda el más antiguo', async () => {
    const sinVencerViejo = lote({
      qty: 5,
      receivedAt: '2026-01-01',
      unitCost: 1_000,
    });
    const sinVencerNuevo = lote({
      qty: 5,
      receivedAt: '2026-06-01',
      unitCost: 1_100,
    });
    const conVencimiento = lote({
      qty: 5,
      expiresAt: '2027-01-01',
      unitCost: 1_200,
    });
    build([sinVencerNuevo, sinVencerViejo, conVencimiento]);

    const consumed = await service.consumeLines(
      'sale',
      sedeId.toString(),
      [{ productId: harinaId.toString(), qty: 15 }],
      user,
    );

    expect(consumed[0]!.portions.map((p) => p.lot)).toEqual([
      conVencimiento,
      sinVencerViejo,
      sinVencerNuevo,
    ]);
  });

  it('no descuenta nada si la existencia consolidada no alcanza', async () => {
    build([lote({ qty: 100, expiresAt: '2026-10-01', unitCost: 3_000 })]);
    // El $inc condicional no encuentra existencia suficiente.
    itemTrasDescuento = null;

    await expect(
      service.consumeLines(
        'sale',
        sedeId.toString(),
        [{ productId: harinaId.toString(), qty: 500 }],
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(movementModel.create).not.toHaveBeenCalled();
  });

  it('falla si los lotes no cubren la cantidad, aunque la existencia diga que sí', async () => {
    // Descuadre entre el consolidado y los lotes: se detiene en vez de inventar
    // mercancía que no está en ningún lote.
    build([lote({ qty: 3, expiresAt: '2026-10-01', unitCost: 3_000 })]);

    await expect(
      service.consumeLines(
        'sale',
        sedeId.toString(),
        [{ productId: harinaId.toString(), qty: 10 }],
        user,
      ),
    ).rejects.toThrow(/no cubren la cantidad/);
  });

  it('un ítem que no controla lotes consume en una sola porción, sin lote', async () => {
    build([], { ...harina, trackLots: false });

    const consumed = await service.consumeLines(
      'sale',
      sedeId.toString(),
      [{ productId: harinaId.toString(), qty: 7 }],
      user,
    );

    expect(consumed[0]!.portions).toEqual([{ qty: 7 }]);
    expect(lotModel.find).not.toHaveBeenCalled();
  });

  describe('kardex', () => {
    it('escribe un movimiento por lote consumido, con su costo', async () => {
      const primero = lote({ qty: 10, expiresAt: '2026-10-01', unitCost: 3_000 });
      const segundo = lote({ qty: 30, expiresAt: '2026-12-01', unitCost: 3_200 });
      build([primero, segundo]);

      await service.consumeLines(
        'sale',
        sedeId.toString(),
        [{ productId: harinaId.toString(), qty: 25 }],
        user,
      );

      const movs = kardex();
      expect(movs).toHaveLength(2);
      expect(movs.map((m) => m.delta)).toEqual([-10, -15]);
      expect(movs.map((m) => m.unitCost)).toEqual([3_000, 3_200]);
      expect(movs.map((m) => m.lotId)).toEqual([primero._id, segundo._id]);
    });

    it('el saldo del kardex baja porción a porción hasta la existencia final', async () => {
      const primero = lote({ qty: 10, expiresAt: '2026-10-01', unitCost: 3_000 });
      const segundo = lote({ qty: 30, expiresAt: '2026-12-01', unitCost: 3_200 });
      build([primero, segundo]);
      itemTrasDescuento = { qty: 75 }; // 100 antes, se sacan 25

      await service.consumeLines(
        'sale',
        sedeId.toString(),
        [{ productId: harinaId.toString(), qty: 25 }],
        user,
      );

      const movs = kardex();
      // 100 → 90 → 75: el último saldo es el que quedó en existencias.
      expect(movs.map((m) => m.balanceAfter)).toEqual([90, 75]);
      expect(movs[movs.length - 1].balanceAfter).toBe(itemTrasDescuento!.qty);
    });

    it('registra el tipo de salida que corresponde: vender no es fabricar', async () => {
      build([lote({ qty: 10, expiresAt: '2026-10-01', unitCost: 3_000 })]);

      await service.consumeLines(
        'production_out',
        sedeId.toString(),
        [{ productId: harinaId.toString(), qty: 5 }],
        user,
      );

      expect(kardex()[0]!.type).toBe('production_out');
    });
  });
});
