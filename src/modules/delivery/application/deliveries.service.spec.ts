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

import { DeliveriesService } from './deliveries.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Seguimiento de domicilios y cuadre por repartidor.
 *
 * La venta ya ocurrió y la plata ya entró: esto es logística. Lo que de verdad
 * se juega es el cuadre del final del turno — el repartidor salió con cinco
 * pedidos, cobró unos en efectivo, y alguien tiene que saber cuánta plata trae
 * en el bolsillo ANTES de que se vaya.
 *
 * Dos errores que costarían plata de verdad:
 *
 * 1. Contar como recaudado lo que se pagó con tarjeta. Esa plata nunca pasó por
 *    las manos del repartidor: exigírsela sería cobrarle dos veces al negocio.
 * 2. Contar lo que todavía no ha entregado. No lo ha cobrado.
 */
describe('DeliveriesService · seguimiento y cuadre', () => {
  const sedeId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  function venta(opts: {
    saleNumber: string;
    status?: string;
    courier?: string;
    method?: string;
    total?: number;
    fee?: number;
  }) {
    return {
      _id: new Types.ObjectId(),
      saleNumber: opts.saleNumber,
      sedeId,
      status: 'completed',
      orderType: 'domicilio',
      total: opts.total ?? 30_000,
      tip: 0,
      deliveryFee: opts.fee ?? 5_000,
      payment: { method: opts.method ?? 'cash' },
      createdAt: new Date(),
      delivery: {
        address: 'Calle 33 #70-20',
        courier: opts.courier,
        status: opts.status ?? 'pendiente',
      },
      markModified: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  let service: DeliveriesService;
  let ventas: any[];
  let filtroUsado: any;

  function build(docs: any[]) {
    ventas = docs;
    filtroUsado = undefined;
    const saleModel = {
      find: vi.fn((filtro: any) => {
        filtroUsado = filtro;
        return {
          sort: () => ({
            limit: () => ({ exec: () => Promise.resolve(ventas) }),
          }),
        };
      }),
      findById: vi.fn((id: string) => ({
        exec: () =>
          Promise.resolve(
            ventas.find((v) => v._id.toString() === id.toString()) ?? null,
          ),
      })),
    };
    service = new DeliveriesService(saleModel as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lista solo los domicilios de la sede, sin las anuladas', async () => {
    build([venta({ saleNumber: 'FV-1' })]);
    const filas = await service.list({ sedeId: sedeId.toString() }, user);

    expect(filtroUsado.orderType).toBe('domicilio');
    expect(filtroUsado.status).toEqual({ $ne: 'void' });
    expect(filas).toHaveLength(1);
    // Lo que el cliente pagó: la venta más el domicilio.
    expect(filas[0]!.grandTotal).toBe(35_000);
  });

  it('marcar "en camino" deja la hora de salida', async () => {
    const v = venta({ saleNumber: 'FV-1' });
    build([v]);

    await service.updateStatus(
      v._id.toString(),
      { status: 'en_camino', courier: 'Andrés' } as never,
      user,
    );

    expect(v.delivery.status).toBe('en_camino');
    expect(v.delivery.courier).toBe('Andrés');
    expect(v.delivery.dispatchedAt).toBeInstanceOf(Date);
  });

  it('marcar entregado de una sola vez no deja la hora de salida vacía', async () => {
    // Es lo normal: el repartidor vuelve y registra todo de un tirón. Sin esto,
    // el tiempo de entrega quedaría sin punto de partida.
    const v = venta({ saleNumber: 'FV-1' });
    build([v]);

    await service.updateStatus(
      v._id.toString(),
      { status: 'entregado' } as never,
      user,
    );

    expect(v.delivery.deliveredAt).toBeInstanceOf(Date);
    expect(v.delivery.dispatchedAt).toBeInstanceOf(Date);
  });

  it('un domicilio entregado no vuelve a "en camino"', async () => {
    // Si de verdad volvió, eso es una devolución de la venta y no un paso atrás
    // de la logística. Dejarlo ir hacia atrás haría el cuadre inauditable.
    const v = venta({ saleNumber: 'FV-1', status: 'entregado' });
    build([v]);

    await expect(
      service.updateStatus(
        v._id.toString(),
        { status: 'en_camino' } as never,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('marcar fallido sin motivo se rechaza', async () => {
    // Sin el motivo nadie puede saber si fue la dirección, el cliente o el
    // repartidor, así que no hay nada que corregir.
    const v = venta({ saleNumber: 'FV-1' });
    build([v]);

    await expect(
      service.updateStatus(
        v._id.toString(),
        { status: 'fallido' } as never,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await service.updateStatus(
      v._id.toString(),
      { status: 'fallido', failureReason: 'Nadie contestó' } as never,
      user,
    );
    expect(v.delivery.failureReason).toBe('Nadie contestó');
  });

  it('una venta que no es domicilio no tiene estado que mover', async () => {
    const v = venta({ saleNumber: 'FV-1' });
    v.orderType = 'mostrador';
    build([v]);

    await expect(
      service.updateStatus(
        v._id.toString(),
        { status: 'en_camino' } as never,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el cuadre solo cuenta el efectivo de lo ENTREGADO', async () => {
    build([
      venta({
        saleNumber: 'FV-1',
        status: 'entregado',
        courier: 'Andrés',
        method: 'cash',
        total: 30_000,
        fee: 5_000,
      }),
      // Tarjeta: esa plata nunca pasó por las manos del repartidor.
      venta({
        saleNumber: 'FV-2',
        status: 'entregado',
        courier: 'Andrés',
        method: 'card',
        total: 20_000,
        fee: 5_000,
      }),
      // Todavía no lo ha entregado: todavía no lo ha cobrado.
      venta({
        saleNumber: 'FV-3',
        status: 'en_camino',
        courier: 'Andrés',
        method: 'cash',
        total: 50_000,
        fee: 5_000,
      }),
    ]);

    const [andres] = await service.settlement(
      { sedeId: sedeId.toString() },
      user,
    );

    expect(andres!.courier).toBe('Andrés');
    expect(andres!.entregados).toBe(2);
    expect(andres!.enCamino).toBe(1);
    expect(andres!.efectivoRecaudado).toBe(35_000); // solo el de contado
    expect(andres!.domiciliosCobrados).toBe(10_000); // los dos entregados
  });

  it('los domicilios sin repartidor se agrupan aparte, no se pierden', async () => {
    // Son los que alguien tiene que reclamar antes de cerrar el turno.
    build([
      venta({ saleNumber: 'FV-1', status: 'entregado', method: 'cash' }),
      venta({
        saleNumber: 'FV-2',
        status: 'entregado',
        courier: 'Andrés',
        method: 'cash',
      }),
    ]);

    const cuadre = await service.settlement(
      { sedeId: sedeId.toString() },
      user,
    );
    expect(cuadre.map((c) => c.courier).sort()).toEqual([
      'Andrés',
      'Sin asignar',
    ]);
  });

  it('un fallido no suma plata, pero sí se cuenta', async () => {
    build([
      venta({
        saleNumber: 'FV-1',
        status: 'fallido',
        courier: 'Andrés',
        method: 'cash',
      }),
    ]);

    const [andres] = await service.settlement(
      { sedeId: sedeId.toString() },
      user,
    );
    expect(andres!.fallidos).toBe(1);
    expect(andres!.efectivoRecaudado).toBe(0);
    expect(andres!.domiciliosCobrados).toBe(0);
  });
});
