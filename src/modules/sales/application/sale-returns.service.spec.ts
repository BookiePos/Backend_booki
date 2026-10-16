import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas de ventas.
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

import { SaleReturnsService } from './sale-returns.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Qué pasa cuando el cliente trae dos de las diez que se llevó.
 *
 * Lo delicado no es el cálculo —eso vive en el dominio y tiene sus pruebas—
 * sino lo que se mueve después: mercancía que vuelve al estante, plata que sale
 * del cajón y un asiento en el libro. Cada uno se puede equivocar solo:
 *
 * - Devolver al inventario algo que llegó dañado lo pone otra vez a la venta.
 * - Sacar plata del cajón por una devolución que no fue en efectivo descuadra
 *   el arqueo del cierre, y el cajero paga ese descuadre de su bolsillo.
 * - No registrar la devolución deja la puerta abierta a devolver lo mismo dos
 *   veces.
 */
describe('SaleReturnsService.create · lo que se mueve', () => {
  const sedeId = new Types.ObjectId();
  const saleId = new Types.ObjectId();
  const GASEOSA = new Types.ObjectId(); // producto vendible
  const INV_GASEOSA = new Types.ObjectId(); // ítem de inventario que consume

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  /** Venta de 10 gaseosas por $25.000 con IVA. */
  function venta(overrides: Record<string, unknown> = {}) {
    return {
      _id: saleId,
      saleNumber: 'FV-000123',
      sedeId: { _id: sedeId },
      status: 'completed',
      lines: [
        {
          productId: GASEOSA,
          sku: 'G1',
          name: 'Gaseosa',
          qty: 10,
          unitPrice: 2_500,
          taxBase: 21_008,
          taxAmount: 3_992,
        },
      ],
      components: [
        {
          productId: INV_GASEOSA,
          qty: 10,
          cost: 9_000,
          consumedLots: [{ lotId: new Types.ObjectId(), qty: 10, unitCost: 900 }],
        },
      ],
      ...overrides,
    };
  }

  let service: SaleReturnsService;
  let creado: any;
  let previas: any[];
  let stock: any;
  let caja: any;
  let ledger: any;
  let modelo: any;
  let ventas: any;

  /**
   * @param porUnidad cuánto consume del inventario cada unidad vendible, según
   *   la receta de HOY. Se parametriza para poder simular que alguien la editó
   *   entre la venta y la devolución.
   */
  function build(sale: any = venta(), anteriores: any[] = [], porUnidad = 1) {
    creado = undefined;
    previas = anteriores;

    const model = {
      find: vi.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve(previas) }),
        exec: () => Promise.resolve(previas),
      })),
      create: vi.fn((doc: any) => {
        creado = { ...doc, _id: new Types.ObjectId(), save: vi.fn() };
        return Promise.resolve(creado);
      }),
      deleteOne: vi.fn(() => ({ exec: () => Promise.resolve({ deletedCount: 1 }) })),
    };
    modelo = model;
    stock = {
      reverseSale: vi.fn().mockResolvedValue(undefined),
      adjust: vi.fn().mockResolvedValue(undefined),
    };
    caja = { movement: vi.fn().mockResolvedValue(undefined) };
    ledger = { postSaleReturn: vi.fn().mockResolvedValue(undefined) };

    service = new SaleReturnsService(
      model as never,
      (ventas = { getOrFail: vi.fn().mockResolvedValue(sale) }) as never,
      stock as never,
      {
        loadSellableOrFail: vi
          .fn()
          .mockResolvedValue({ _id: GASEOSA, name: 'Gaseosa' }),
        // Cada gaseosa vendida consume `porUnidad` del inventario.
        componentsOf: vi.fn((_p: unknown, qty: number) => [
          { productId: INV_GASEOSA.toString(), qty: qty * porUnidad },
        ]),
      } as never,
      caja as never,
      ledger as never,
    );
  }

  /** Devolución de `qty` gaseosas con las opciones indicadas. */
  function devolucion(extra: Record<string, unknown> = {}) {
    return {
      lines: [{ productId: GASEOSA.toString(), qty: 2 }],
      reason: 'defectuoso',
      restock: 'inventory',
      refundMethod: 'cash',
      ...extra,
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('devuelve al inventario solo la parte que volvió, a sus mismos lotes', async () => {
    build();
    await service.create(saleId.toString(), devolucion(), user);

    expect(stock.reverseSale).toHaveBeenCalledTimes(1);
    const units = stock.reverseSale.mock.calls[0][1];
    expect(units).toHaveLength(1);
    expect(units[0].qty).toBe(2);
    expect(units[0].consumedLots[0].qty).toBe(2); // 10 vendidas, vuelven 2
  });

  it('registra la devolución ANTES de mover nada', async () => {
    // El orden es la garantía de que no se devuelva lo mismo dos veces: si el
    // registro fuera después, un fallo dejaría mercancía y plata entregadas
    // que nadie vería al validar la siguiente devolución.
    build();
    const orden: string[] = [];
    stock.reverseSale.mockImplementation(() => {
      orden.push('stock');
      return Promise.resolve();
    });
    caja.movement.mockImplementation(() => {
      orden.push('caja');
      return Promise.resolve()
    });

    await service.create(saleId.toString(), devolucion(), user);

    expect(creado).toBeDefined();
    expect(orden).toEqual(['stock', 'caja']);
  });

  it('lo que llegó dañado vuelve y se da de baja: el kárdex cuenta las dos cosas', async () => {
    build();
    await service.create(
      saleId.toString(),
      devolucion({ restock: 'waste' }),
      user,
    );

    expect(stock.reverseSale).toHaveBeenCalledTimes(1);
    expect(stock.adjust).toHaveBeenCalledTimes(1);
    const ajuste = stock.adjust.mock.calls[0][0];
    expect(ajuste.direction).toBe('remove');
    expect(ajuste.reason).toBe('dano');
    expect(ajuste.qty).toBe(2);
    expect(creado.wasteRecorded).toBe(true);
  });

  it('si la baja falla queda existencia de más, visible, y no al revés', async () => {
    // Descontar sin haber devuelto dejaría el inventario corto en silencio.
    build();
    stock.adjust.mockRejectedValue(new Error('sin stock'));

    await service.create(
      saleId.toString(),
      devolucion({ restock: 'waste' }),
      user,
    );

    expect(creado.wasteRecorded).toBe(false);
  });

  it('lo que vuelve al estante NO se da de baja', async () => {
    build();
    await service.create(saleId.toString(), devolucion(), user);
    expect(stock.adjust).not.toHaveBeenCalled();
  });

  it('el efectivo sale de la caja del turno, por lo que de verdad se devolvió', async () => {
    build();
    await service.create(saleId.toString(), devolucion(), user);

    expect(caja.movement).toHaveBeenCalledTimes(1);
    const mov = caja.movement.mock.calls[0][0];
    expect(mov.type).toBe('out');
    expect(mov.amount).toBe(5_000); // 25.000 / 10 × 2
    expect(mov.sedeId).toBe(sedeId.toString());
  });

  it('una transferencia o una nota a favor NO vacían el cajón', async () => {
    // Anotarlas en caja descuadraría el arqueo del cierre, y ese descuadre lo
    // termina pagando el cajero.
    build();
    await service.create(
      saleId.toString(),
      devolucion({ refundMethod: 'transfer' }),
      user,
    );
    expect(caja.movement).not.toHaveBeenCalled();

    build();
    await service.create(
      saleId.toString(),
      devolucion({ refundMethod: 'none' }),
      user,
    );
    expect(caja.movement).not.toHaveBeenCalled();
  });

  it('un fallo de la caja no tumba la devolución ya registrada', async () => {
    build();
    caja.movement.mockRejectedValue(new Error('caja cerrada'));

    await expect(
      service.create(saleId.toString(), devolucion(), user),
    ).resolves.toBeDefined();
  });

  it('la devolución de una línea con INC reversa INC, no IVA (ítem 1.3)', async () => {
    const base = venta();
    build(
      venta({
        lines: [{ ...base.lines[0], taxBase: 23_148, taxAmount: 1_852, taxKind: 'inc' }],
      }),
    );
    await service.create(saleId.toString(), devolucion(), user);

    const asiento = ledger.postSaleReturn.mock.calls[0][0];
    // 2 de 10: 1.852 × 0,2 = 370 de INC.
    expect(asiento.consumptionTax).toBe(370);
    expect(asiento.tax).toBe(0);
  });

  it('IVA e INC devueltos se suman por tipo, sin redondear dos veces (sumBy por taxKind)', async () => {
    const SANDWICH = new Types.ObjectId();
    const base = venta();
    build(
      venta({
        lines: [
          { ...base.lines[0], taxKind: 'iva' },
          { ...base.lines[0], productId: SANDWICH, taxKind: 'inc' },
        ],
      }),
    );
    // Un registro con fracciones de peso por renglón (los guardados antes de
    // redondear la devolución): restar el INC ya redondeado del total sin
    // redondear dejaba un IVA de 100,2.
    modelo.create.mockImplementation((doc: any) => {
      creado = {
        ...doc,
        lines: [
          { ...doc.lines[0], productId: GASEOSA, refundTax: 100.6 },
          { ...doc.lines[0], productId: SANDWICH, refundTax: 50.6 },
        ],
        refundTax: 151.2,
        _id: new Types.ObjectId(),
        save: vi.fn(),
      };
      return Promise.resolve(creado);
    });
    await service.create(saleId.toString(), devolucion(), user);

    const asiento = ledger.postSaleReturn.mock.calls[0][0];
    expect(asiento.tax).toBe(101);
    expect(asiento.consumptionTax).toBe(51);
  });

  it('una línea vieja sin taxKind sigue reversando IVA', async () => {
    build();
    await service.create(saleId.toString(), devolucion(), user);

    const asiento = ledger.postSaleReturn.mock.calls[0][0];
    expect(asiento.tax).toBe(798); // 3.992 × 0,2
    expect(asiento.consumptionTax).toBe(0);
  });

  it('el asiento deshace el costo solo si la mercancía volvió al inventario', async () => {
    build();
    await service.create(saleId.toString(), devolucion(), user);
    expect(ledger.postSaleReturn.mock.calls[0][0].cogs).toBe(1_800); // 900 × 2

    build();
    await service.create(
      saleId.toString(),
      devolucion({ restock: 'waste' }),
      user,
    );
    // Se fue a merma: el inventario se perdió igual, el costo se queda.
    expect(ledger.postSaleReturn.mock.calls[0][0].cogs).toBe(0);
  });

  it('una venta anulada no admite devoluciones: ya se devolvió completa', async () => {
    build(venta({ status: 'void' }));
    await expect(
      service.create(saleId.toString(), devolucion(), user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stock.reverseSale).not.toHaveBeenCalled();
  });

  it('cuenta las devoluciones anteriores y no deja pasarse del total vendido', async () => {
    build(venta(), [
      { lines: [{ productId: GASEOSA, qty: 9 }] },
    ]);

    await expect(
      service.create(saleId.toString(), devolucion(), user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(caja.movement).not.toHaveBeenCalled();
  });

  it('no devuelve al inventario más de lo que la venta consumió', async () => {
    // La receta de hoy dice 25 por unidad, pero la venta solo sacó 10 en
    // total: alguien la editó después de vender. Sin tope entraría al
    // inventario mercancía que nunca salió de él.
    build(venta(), [], 25);

    await service.create(saleId.toString(), devolucion(), user);

    const units = stock.reverseSale.mock.calls[0][1];
    expect(units[0].qty).toBe(10);
  });

  it('el tope descuenta lo que ya volvió en devoluciones anteriores (ítem 1.16)', async () => {
    // Ya volvieron 8 de las 10 que consumió la venta; con la receta inflada a
    // 25 por unidad, sin descontar lo anterior entrarían otras 10.
    build(
      venta(),
      [
        {
          lines: [{ productId: GASEOSA, qty: 2, refund: 5_000, refundTax: 798 }],
          components: [{ productId: INV_GASEOSA, qty: 8, cogs: 7_200 }],
        },
      ],
      25,
    );

    await service.create(saleId.toString(), devolucion(), user);

    const units = stock.reverseSale.mock.calls[0][1];
    expect(units[0].qty).toBe(2);
    // Y el costo es el de esas 2 que faltaban: 9.000 − 7.200.
    expect(ledger.postSaleReturn.mock.calls[0][0].cogs).toBe(1_800);
    expect(creado.components).toEqual([
      expect.objectContaining({ qty: 2, cogs: 1_800 }),
    ]);
  });

  it('si la venta se anuló mientras se registraba, borra el registro y no mueve nada', async () => {
    // Revisión inicial: completada. Al volver a mirar tras crear el registro,
    // una anulación simultánea ya la tomó (y revertirá todo el stock).
    build();
    ventas.getOrFail
      .mockResolvedValueOnce(venta())
      .mockResolvedValueOnce(venta({ status: 'void' }));

    await expect(
      service.create(saleId.toString(), devolucion(), user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(modelo.create).toHaveBeenCalledTimes(1);
    expect(modelo.deleteOne).toHaveBeenCalledWith({ _id: creado._id });
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(caja.movement).not.toHaveBeenCalled();
    expect(ledger.postSaleReturn).not.toHaveBeenCalled();
  });

  it('el asiento de la devolución lleva la fecha de Colombia, no la UTC', async () => {
    // 15-oct 02:00 UTC es todavía 14-oct en Bogotá.
    build();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T02:00:00Z'));
    try {
      await service.create(saleId.toString(), devolucion(), user);
    } finally {
      vi.useRealTimers();
    }
    expect(ledger.postSaleReturn.mock.calls[0][0].date).toBe('2026-10-14');
  });
});
