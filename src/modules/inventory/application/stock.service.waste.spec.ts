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

/**
 * Reporte de merma: qué se botó, por qué y cuánto costó.
 *
 * La merma es la plata que se pierde sin que nadie la vea salir. Cada baja
 * queda en el kárdex desde siempre, pero una a una no dice nada: lo que revela
 * el problema es el acumulado — "el mes pasado se botaron $340.000 de leche por
 * vencimiento".
 *
 * Dos cosas se protegen aquí:
 *
 * 1. Que un **ajuste por conteo no cuente como merma**. Un conteo corrige lo
 *    que el sistema creía; mezclarlo escondería la merma de verdad detrás del
 *    ruido del inventario, y justificaría no hacer nada.
 * 2. Que el costo sea el del **lote que salió**, no el de hoy. Lo que se perdió
 *    se perdió al precio al que se había comprado.
 */
describe('StockService.wasteReport · qué se botó y cuánto costó', () => {
  const sedeId = new Types.ObjectId();
  const LECHE = new Types.ObjectId();
  const PAN = new Types.ObjectId();

  let movimientos: any[];
  let filtroUsado: any;
  let service: StockService;

  function movimiento(opts: {
    productId: Types.ObjectId;
    name: string;
    delta: number;
    unitCost: number;
    reason?: string;
  }) {
    return {
      type: 'waste',
      productId: {
        _id: opts.productId,
        sku: opts.name.slice(0, 3).toUpperCase(),
        name: opts.name,
        unit: 'und',
      },
      sedeId: { _id: sedeId, code: 'S1', name: 'Sede 1' },
      delta: opts.delta,
      unitCost: opts.unitCost,
      reason: opts.reason,
      createdAt: new Date('2026-09-10'),
    };
  }

  function build(docs: any[]) {
    movimientos = docs;
    filtroUsado = undefined;
    const movementModel = {
      find: vi.fn((filtro: any) => {
        filtroUsado = filtro;
        return {
          sort: () => ({
            limit: () => ({
              populate: () => ({
                populate: () => ({ exec: () => Promise.resolve(movimientos) }),
              }),
            }),
          }),
        };
      }),
    };

    service = new StockService(
      {} as never,
      {} as never,
      movementModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('suma lo botado por producto y lo valora al costo del lote que salió', async () => {
    build([
      movimiento({
        productId: LECHE,
        name: 'Leche',
        delta: -6,
        unitCost: 4_000,
        reason: 'vencimiento',
      }),
      movimiento({
        productId: LECHE,
        name: 'Leche',
        delta: -2,
        unitCost: 4_500, // otro lote, comprado más caro
        reason: 'dano',
      }),
    ]);

    const r = await service.wasteReport({});

    expect(r.totalQty).toBe(8);
    expect(r.totalValue).toBe(24_000 + 9_000);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.name).toBe('Leche');
    expect(r.rows[0]!.byReason.vencimiento).toEqual({ qty: 6, value: 24_000 });
    expect(r.rows[0]!.byReason.dano).toEqual({ qty: 2, value: 9_000 });
  });

  it('ordena por plata perdida, no por cantidad', async () => {
    // Lo primero que hay que mirar es lo que más cuesta. Trescientos panes de
    // $500 duelen menos que diez quesos de $30.000.
    build([
      movimiento({
        productId: PAN,
        name: 'Pan',
        delta: -300,
        unitCost: 500,
        reason: 'merma',
      }),
      movimiento({
        productId: LECHE,
        name: 'Queso',
        delta: -10,
        unitCost: 30_000,
        reason: 'vencimiento',
      }),
    ]);

    const r = await service.wasteReport({});
    expect(r.rows.map((f) => f.name)).toEqual(['Queso', 'Pan']);
  });

  it('agrupa el total por razón: dice dónde atacar', async () => {
    build([
      movimiento({
        productId: LECHE,
        name: 'Leche',
        delta: -6,
        unitCost: 4_000,
        reason: 'vencimiento',
      }),
      movimiento({
        productId: PAN,
        name: 'Pan',
        delta: -10,
        unitCost: 500,
        reason: 'vencimiento',
      }),
      movimiento({
        productId: PAN,
        name: 'Pan',
        delta: -4,
        unitCost: 500,
        reason: 'merma',
      }),
    ]);

    const r = await service.wasteReport({});
    expect(r.byReason.vencimiento).toEqual({ qty: 16, value: 29_000 });
    expect(r.byReason.merma).toEqual({ qty: 4, value: 2_000 });
  });

  it('solo cuenta bajas: un ajuste por conteo NO es merma', async () => {
    // Es la distinción que hace útil el reporte. Un conteo corrige lo que el
    // sistema creía; contarlo como merma escondería el problema de verdad.
    build([]);
    await service.wasteReport({});
    expect(filtroUsado.type).toBe('waste');
  });

  it('el "hasta" es inclusivo: quien escribe 30 espera que el 30 entre', async () => {
    build([]);
    await service.wasteReport({ from: '2026-09-01', to: '2026-09-30' });

    const rango = filtroUsado.createdAt;
    expect(rango.$gte).toEqual(new Date('2026-09-01T00:00:00'));
    expect(rango.$lte).toEqual(new Date('2026-09-30T23:59:59.999'));
  });

  it('sin fechas no filtra por fecha: sale todo', async () => {
    build([]);
    await service.wasteReport({});
    expect(filtroUsado.createdAt).toBeUndefined();
  });

  it('una baja sin razón se agrupa como "otro" en vez de perderse', async () => {
    build([
      movimiento({ productId: PAN, name: 'Pan', delta: -3, unitCost: 500 }),
    ]);
    const r = await service.wasteReport({});
    expect(r.byReason.otro).toEqual({ qty: 3, value: 1_500 });
  });

  it('un producto ya borrado no rompe el reporte', async () => {
    build([
      {
        type: 'waste',
        productId: null,
        delta: -5,
        unitCost: 1_000,
        reason: 'dano',
      },
      movimiento({
        productId: PAN,
        name: 'Pan',
        delta: -2,
        unitCost: 500,
        reason: 'dano',
      }),
    ]);

    const r = await service.wasteReport({});
    expect(r.rows).toHaveLength(1);
    expect(r.totalQty).toBe(2);
  });
});
