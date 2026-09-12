import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
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

import { TraceabilityService } from './traceability.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Trazabilidad hacia adelante: "el lote L-2409 salió malo, ¿a dónde se fue?".
 *
 * Es la pregunta del INVIMA y la que hay que poder responder en una hora. Para
 * una galletería la respuesta casi nunca es directa: el bulto de harina no se
 * vendió, se horneó. Entró a una tanda, salió convertido en galletas con OTRO
 * lote, y fue ese el que llegó a los clientes.
 *
 * Si la cadena se corta en el primer salto, el reporte dice "este lote no se
 * vendió a nadie" y es mentira — de la peor clase, porque suena tranquilizadora
 * mientras el producto sigue en la calle.
 */
describe('TraceabilityService.traceLot · a dónde se fue el lote', () => {
  const sedeId = new Types.ObjectId();
  const LOTE_HARINA = new Types.ObjectId();
  const LOTE_GALLETA = new Types.ObjectId();
  const HARINA = new Types.ObjectId();
  const GALLETA = new Types.ObjectId();
  const ORDEN = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'calidad@bookipos.local',
    name: 'Calidad',
    role: 'admin',
    sedeIds: null,
    permissions: [],
  } as unknown as JwtUser;

  function lote(opts: {
    _id: Types.ObjectId;
    productId: Types.ObjectId;
    lotCode: string;
    qty?: number;
  }) {
    return {
      _id: opts._id,
      productId: opts.productId,
      sedeId,
      lotCode: opts.lotCode,
      supplier: 'Molinos del Valle',
      expiresAt: new Date('2026-12-01'),
      qty: opts.qty ?? 0,
      initialQty: 25_000,
      receivedAt: new Date('2026-09-01'),
    };
  }

  function venta(opts: {
    saleNumber: string;
    lotId: Types.ObjectId;
    qty: number;
    customer?: Record<string, string>;
  }) {
    return {
      _id: new Types.ObjectId(),
      saleNumber: opts.saleNumber,
      status: 'completed',
      createdAt: new Date('2026-09-10'),
      customer: opts.customer,
      components: [
        {
          productId: GALLETA,
          qty: opts.qty,
          consumedLots: [{ lotId: opts.lotId, qty: opts.qty }],
        },
      ],
    };
  }

  let service: TraceabilityService;

  /**
   * @param lotes lotes por id
   * @param ventasPorLote ventas que consumieron cada lote
   * @param movimientos salidas de producción por lote (con su nota)
   * @param ordenes órdenes de producción por número
   */
  function build(opts: {
    lotes: Record<string, unknown>;
    ventasPorLote?: Record<string, unknown[]>;
    movimientos?: Record<string, { note: string }[]>;
    ordenes?: unknown[];
    lotesPorCodigo?: Record<string, unknown[]>;
  }) {
    const lotModel = {
      findById: vi.fn((id: string) => ({
        exec: () => Promise.resolve(opts.lotes[id.toString()] ?? null),
      })),
      find: vi.fn((filtro: any) => ({
        select: () => ({
          exec: () =>
            Promise.resolve(opts.lotesPorCodigo?.[filtro.lotCode] ?? []),
        }),
        sort: () => ({ limit: () => ({ exec: () => Promise.resolve([]) }) }),
      })),
    };
    const movementModel = {
      find: vi.fn((filtro: any) => ({
        select: () => ({
          exec: () =>
            Promise.resolve(
              opts.movimientos?.[filtro.lotId.toString()] ?? [],
            ),
        }),
      })),
    };
    const productModel = {
      find: vi.fn(() => ({
        select: () => ({
          exec: () =>
            Promise.resolve([
              { _id: HARINA, name: 'Harina' },
              { _id: GALLETA, name: 'Galleta de avena' },
            ]),
        }),
      })),
    };
    const saleModel = {
      find: vi.fn((filtro: any) => ({
        sort: () => ({
          limit: () => ({
            exec: () =>
              Promise.resolve(
                opts.ventasPorLote?.[
                  filtro['components.consumedLots.lotId'].toString()
                ] ?? [],
              ),
          }),
        }),
      })),
    };
    const orderModel = {
      find: vi.fn(() => ({ exec: () => Promise.resolve(opts.ordenes ?? []) })),
    };

    service = new TraceabilityService(
      lotModel as never,
      movementModel as never,
      productModel as never,
      saleModel as never,
      orderModel as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encuentra las ventas directas del lote y a quién le llegaron', async () => {
    build({
      lotes: {
        [LOTE_GALLETA.toString()]: lote({
          _id: LOTE_GALLETA,
          productId: GALLETA,
          lotCode: 'OP-000007',
        }),
      },
      ventasPorLote: {
        [LOTE_GALLETA.toString()]: [
          venta({
            saleNumber: 'FV-000100',
            lotId: LOTE_GALLETA,
            qty: 3,
            customer: { name: 'Tienda La Esquina', idNumber: '900123' },
          }),
        ],
      },
    });

    const r = await service.traceLot(LOTE_GALLETA.toString(), user);

    expect(r.sales).toHaveLength(1);
    expect(r.sales[0]!.saleNumber).toBe('FV-000100');
    expect(r.sales[0]!.qty).toBe(3);
    expect(r.customers).toHaveLength(1);
    expect(r.customers[0]!.name).toBe('Tienda La Esquina');
  });

  it('sigue la cadena: la harina no se vendió, se horneó y salió como galleta', async () => {
    // El caso que da sentido a todo esto. Si la cadena se cortara aquí, el
    // reporte diría "esta harina no se vendió a nadie" mientras las galletas
    // que salieron de ella están en la calle.
    build({
      lotes: {
        [LOTE_HARINA.toString()]: lote({
          _id: LOTE_HARINA,
          productId: HARINA,
          lotCode: 'L-2409',
        }),
        [LOTE_GALLETA.toString()]: lote({
          _id: LOTE_GALLETA,
          productId: GALLETA,
          lotCode: 'OP-000007',
        }),
      },
      movimientos: {
        [LOTE_HARINA.toString()]: [{ note: 'Producción OP-000007' }],
      },
      ordenes: [
        {
          _id: ORDEN,
          number: 'OP-000007',
          date: '2026-09-05',
          productId: GALLETA,
          productName: 'Galleta de avena',
          producedQty: 240,
          lotCode: 'OP-000007',
        },
      ],
      lotesPorCodigo: { 'OP-000007': [{ _id: LOTE_GALLETA }] },
      ventasPorLote: {
        [LOTE_GALLETA.toString()]: [
          venta({
            saleNumber: 'FV-000100',
            lotId: LOTE_GALLETA,
            qty: 12,
            customer: { name: 'Panadería Mazuera', idNumber: '900999' },
          }),
        ],
      },
    });

    const r = await service.traceLot(LOTE_HARINA.toString(), user);

    expect(r.sales).toHaveLength(0); // la harina misma no se vendió
    expect(r.producedInto).toHaveLength(1);
    expect(r.producedInto[0]!.number).toBe('OP-000007');
    expect(r.producedInto[0]!.outputs[0]!.lotCode).toBe('OP-000007');
    // Y lo que importa: sí llegó a un cliente, por el camino largo.
    expect(r.soldQty).toBe(12);
    expect(r.customers[0]!.name).toBe('Panadería Mazuera');
  });

  it('cuenta solo lo que salió de ESE lote cuando la venta descontó de varios', async () => {
    // FEFO reparte cuando un lote no alcanza: la venta tocó dos lotes y aquí
    // solo cuenta la parte del que se está rastreando.
    const otro = new Types.ObjectId();
    build({
      lotes: {
        [LOTE_GALLETA.toString()]: lote({
          _id: LOTE_GALLETA,
          productId: GALLETA,
          lotCode: 'OP-000007',
        }),
      },
      ventasPorLote: {
        [LOTE_GALLETA.toString()]: [
          {
            _id: new Types.ObjectId(),
            saleNumber: 'FV-000101',
            status: 'completed',
            createdAt: new Date(),
            components: [
              {
                productId: GALLETA,
                qty: 10,
                consumedLots: [
                  { lotId: LOTE_GALLETA, qty: 4 },
                  { lotId: otro, qty: 6 },
                ],
              },
            ],
          },
        ],
      },
    });

    const r = await service.traceLot(LOTE_GALLETA.toString(), user);
    expect(r.sales[0]!.qty).toBe(4);
  });

  it('no cuenta dos veces al mismo cliente que compró varias veces', async () => {
    build({
      lotes: {
        [LOTE_GALLETA.toString()]: lote({
          _id: LOTE_GALLETA,
          productId: GALLETA,
          lotCode: 'OP-000007',
        }),
      },
      ventasPorLote: {
        [LOTE_GALLETA.toString()]: [
          venta({
            saleNumber: 'FV-1',
            lotId: LOTE_GALLETA,
            qty: 2,
            customer: { name: 'Tienda La Esquina', idNumber: '900123' },
          }),
          venta({
            saleNumber: 'FV-2',
            lotId: LOTE_GALLETA,
            qty: 5,
            customer: { name: 'TIENDA LA ESQUINA', idNumber: '900123' },
          }),
        ],
      },
    });

    const r = await service.traceLot(LOTE_GALLETA.toString(), user);
    expect(r.sales).toHaveLength(2);
    expect(r.customers).toHaveLength(1);
    expect(r.soldQty).toBe(7);
  });

  it('una venta de mostrador sin datos del cliente no inventa uno', async () => {
    build({
      lotes: {
        [LOTE_GALLETA.toString()]: lote({
          _id: LOTE_GALLETA,
          productId: GALLETA,
          lotCode: 'OP-000007',
        }),
      },
      ventasPorLote: {
        [LOTE_GALLETA.toString()]: [
          venta({ saleNumber: 'FV-3', lotId: LOTE_GALLETA, qty: 1 }),
        ],
      },
    });

    const r = await service.traceLot(LOTE_GALLETA.toString(), user);
    expect(r.sales[0]!.customer).toBeNull();
    expect(r.customers).toHaveLength(0);
    // Pero la unidad SÍ se contó: se vendió, aunque no se sepa a quién.
    expect(r.soldQty).toBe(1);
  });

  it('una receta que se refiere a sí misma no deja la consulta dando vueltas', async () => {
    // El lote produce una orden cuyo terminado es el mismo lote. Sin la marca
    // de visitados esto no terminaría nunca.
    build({
      lotes: {
        [LOTE_HARINA.toString()]: lote({
          _id: LOTE_HARINA,
          productId: HARINA,
          lotCode: 'L-2409',
        }),
      },
      movimientos: {
        [LOTE_HARINA.toString()]: [{ note: 'Producción OP-000007' }],
      },
      ordenes: [
        {
          _id: ORDEN,
          number: 'OP-000007',
          date: '2026-09-05',
          productId: HARINA,
          productName: 'Harina',
          producedQty: 1,
          lotCode: 'L-2409',
        },
      ],
      lotesPorCodigo: { 'L-2409': [{ _id: LOTE_HARINA }] },
    });

    const r = await service.traceLot(LOTE_HARINA.toString(), user);
    expect(r.producedInto[0]!.outputs).toHaveLength(0);
  });

  it('un lote que no existe es 404, no una respuesta vacía', async () => {
    // Una respuesta vacía se leería como "no se vendió a nadie", que es lo
    // contrario de lo que hay que responder cuando el lote no se encontró.
    build({ lotes: {} });
    await expect(
      service.traceLot(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un id que ni siquiera tiene forma de id es 404', async () => {
    build({ lotes: {} });
    await expect(service.traceLot('no-es-un-id', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
