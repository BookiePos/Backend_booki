import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

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

// La transmisión va detrás de la respuesta: aquí se captura para esperarla.
const enSegundoPlano: Promise<unknown>[] = [];
vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => void enSegundoPlano.push(p),
}));

import { SaleReturnsService } from './sale-returns.service';
import { NotaFiscalVentaService } from './nota-fiscal-venta.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * La devolución con su nota fiscal (Fase 6B): la nota lleva los MISMOS
 * valores que el libro, se emite antes de mover nada (si falla no se mueve
 * nada), se transmite detrás sin bloquear la caja, el reintento con la misma
 * llave no duplica nada, y en una venta fiada baja la cartera en vez de sacar
 * plata.
 */
describe('SaleReturnsService · rebaja posterior (Fase 6C)', () => {
  const sedeId = new Types.ObjectId();
  const saleId = new Types.ObjectId();
  const HAMB = new Types.ObjectId();
  const GAS = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  /** 3 hamburguesas con INC ($30.000) y 2 gaseosas con IVA ($10.000). */
  function venta(o: Record<string, unknown> = {}) {
    return {
      _id: saleId,
      saleNumber: 'FV-000123',
      sedeId: { _id: sedeId },
      status: 'completed',
      payment: { method: 'cash' },
      lines: [
        { productId: HAMB, sku: 'H1', name: 'Hamburguesa', qty: 3, taxKind: 'inc', taxBase: 27_778, taxAmount: 2_222 },
        { productId: GAS, sku: 'G1', name: 'Gaseosa', qty: 2, taxKind: 'iva', taxBase: 8_403, taxAmount: 1_597 },
      ],
      components: [
        { productId: HAMB, qty: 3, cost: 12_000, consumedLots: [] },
        { productId: GAS, qty: 2, cost: 4_000, consumedLots: [] },
      ],
      ...o,
    };
  }

  let service: SaleReturnsService;
  let registros: any[];
  let model: any;
  let stock: any;
  let caja: any;
  let ledger: any;
  let receivables: any;
  let cxc: any;
  let puerto: any;
  let orden: string[];
  let saldoFavor: any;

  function build(sale: any = venta(), conNotas = true) {
    registros = [];
    orden = [];
    saldoFavor = { abonar: vi.fn(async () => void orden.push('saldo')) };
    model = {
      find: vi.fn((f: any = {}) => {
        const filtrados = () =>
          registros.filter(
            (r) =>
              (!f.estado || r.estado === f.estado) &&
              (!f.createdAt || (r.createdAt && r.createdAt < f.createdAt.$lt)) &&
              (!f.$or || !r.procesandoHasta || r.procesandoHasta < new Date()),
          );
        return {
          sort: () => ({ exec: async () => filtrados(), limit: () => ({ exec: async () => filtrados() }) }),
          exec: async () => filtrados(),
        };
      }),
      findOne: vi.fn((f: any) => ({
        exec: async () => registros.find((r) => r.idempotencyKey && r.idempotencyKey === f.idempotencyKey) ?? null,
      })),
      create: vi.fn(async (d: any) => {
        const r = { ...d, _id: new Types.ObjectId(), save: vi.fn(async () => undefined) };
        registros.push(r);
        return r;
      }),
      // Turno atómico (N1): lo toma quien encuentre la devolución en curso y
      // sin turno vigente, como el `findOneAndUpdate` condicionado de Mongo.
      findOneAndUpdate: vi.fn((f: any, upd: any) => ({
        exec: async () => {
          const r = registros.find((x) => String(x._id) === String(f._id));
          if (!r || !(f.estado?.$in ?? [f.estado]).includes(r.estado)) return null;
          if (r.procesandoHasta && r.procesandoHasta >= new Date()) return null;
          Object.assign(r, upd.$set);
          return r;
        },
      })),
      updateOne: vi.fn((f: any, upd: any) => ({
        exec: async () => {
          const r = registros.find((x) => String(x._id) === String(f._id));
          // Condicionado al turno propio (N5), como el filtro de Mongo.
          if ('procesandoHasta' in f && r?.procesandoHasta?.getTime?.() !== f.procesandoHasta?.getTime?.()) {
            return {};
          }
          if (r) Object.assign(r, upd.$set);
          return {};
        },
      })),
      findById: vi.fn((id: any) => ({
        exec: async () => registros.find((x) => String(x._id) === String(id)) ?? null,
      })),
      deleteOne: vi.fn((f: any) => ({
        exec: async () => {
          registros = registros.filter((r) => String(r._id) !== String(f._id));
          return { deletedCount: 1 };
        },
      })),
    };
    stock = {
      reverseSale: vi.fn(async () => void orden.push('stock')),
      adjust: vi.fn(async () => undefined),
    };
    caja = { movement: vi.fn(async () => void orden.push('caja')) };
    ledger = { postSaleReturn: vi.fn(async () => void orden.push('libro')) };
    cxc = null;
    receivables = {
      findOne: vi.fn(() => ({ exec: async () => cxc })),
      findOneAndUpdate: vi.fn((f: any, upd: any) => ({
        exec: async () => {
          if (!cxc) return null;
          if (f.amount !== undefined && (f.amount !== cxc.amount || f.paidAmount !== cxc.paidAmount)) return null;
          cxc = { ...cxc, amount: cxc.amount + upd.$inc.amount, status: upd.$set?.status ?? cxc.status };
          orden.push('cartera');
          return cxc;
        },
      })),
      updateOne: vi.fn(() => ({ exec: async () => ({}) })),
    };
    puerto = {
      emitirNota: vi.fn(async (s: any) => {
        orden.push('nota');
        return {
          estado: 'emitida',
          documentoId: 'nota-1',
          fullNumber: 'NC1',
          referenceType: 'invoice',
          concepto: s.concepto,
          dianStatus: 'draft',
        };
      }),
      transmitir: vi.fn(async () => undefined),
    };
    const notas = new NotaFiscalVentaService({ get: () => puerto } as never);
    service = new SaleReturnsService(
      model as never,
      { getOrFail: vi.fn(async () => sale) } as never,
      stock as never,
      {
        loadSellableOrFail: vi.fn(async (id: string) => ({ _id: id })),
        componentsOf: vi.fn((p: { _id: string }, qty: number) => [{ productId: String(p._id), qty }]),
      } as never,
      caja as never,
      ledger as never,
      receivables as never,
      conNotas ? notas : undefined,
      saldoFavor as never,
    );
  }

  const devolucion = (extra: Record<string, unknown> = {}) =>
    ({
      lines: [{ productId: HAMB.toString(), qty: 1 }, { productId: GAS.toString(), qty: 1 }],
      reason: 'defectuoso',
      restock: 'inventory',
      refundMethod: 'cash',
      ...extra,
    }) as never;

  const rebaja = (extra: Record<string, unknown> = {}) =>
    ({
      concepto: '3',
      amount: 4_000,
      refundMethod: 'cash',
      reason: 'Queja del servicio',
      idempotencyKey: 'rebaja-0001',
      ...extra,
    }) as never;

  beforeEach(() => {
    enSegundoPlano.length = 0;
  });

  it('reparte el total por lo pagado de cada producto, con su impuesto, y no mueve stock', async () => {
    build();
    const r: any = await service.createRebaja(saleId.toString(), rebaja(), user);
    expect(r.kind).toBe('rebaja');
    expect(r.refundTotal).toBe(4_000);
    // $30.000 de hamburguesa y $10.000 de gaseosa → $3.000 y $1.000.
    const [h, g] = r.lines;
    expect([h.refund, g.refund]).toEqual([3_000, 1_000]);
    expect(h.refundTax).toBe(222); // 3.000 × 2.222 / 30.000
    expect(g.refundTax).toBe(160); // 1.000 × 1.597 / 10.000
    expect(h.qty).toBe(0);
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(orden).toEqual(['nota', 'caja', 'libro']);
    expect(r.estado).toBe('completa');
  });

  it('la nota lleva el concepto, el origen propio y los valores del libro', async () => {
    build();
    const r: any = await service.createRebaja(saleId.toString(), rebaja({ concepto: '5' }), user);
    const [s] = puerto.emitirNota.mock.calls[0];
    expect(s.origen).toBe(`rebaja:${String(r._id)}`);
    expect(s.concepto).toBe('5');
    expect(s.propina).toBeUndefined();
    expect(s.lineas.map((l: any) => [l.valor, l.impuesto, l.qty])).toEqual([
      [3_000, 222, 0],
      [1_000, 160, 0],
    ]);
    const asiento = ledger.postSaleReturn.mock.calls[0][0];
    expect(asiento).toMatchObject({ refundTotal: 4_000, tax: 160, consumptionTax: 222, cogs: 0, tip: 0, refundMethod: 'cash' });
    expect(asiento.memo).toMatch(/Rebaja posterior/);
  });

  it('saldo a favor: no toca la caja y el asiento va con credit_note (2805)', async () => {
    const CLIENTE = new Types.ObjectId();
    build(venta({ customerId: CLIENTE, customer: { name: 'Ana' } }));
    const r: any = await service.createRebaja(saleId.toString(), rebaja({ refundMethod: 'credit_note' }), user);
    expect(caja.movement).not.toHaveBeenCalled();
    // Fase 6C: el tercero recibe el abono antes del asiento que acredita la 2805.
    expect(orden).toEqual(['nota', 'saldo', 'libro']);
    expect(saldoFavor.abonar).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CLIENTE, amount: 4_000, sourceType: 'sale_return', sourceId: String(r._id) }),
    );
    expect(ledger.postSaleReturn.mock.calls[0][0].refundMethod).toBe('credit_note');
  });

  it('en efectivo no abona saldo a favor', async () => {
    build();
    await service.createRebaja(saleId.toString(), rebaja(), user);
    expect(saldoFavor.abonar).not.toHaveBeenCalled();
  });

  it('devolución a favor de una venta fiada sin tercero en la venta: el tercero sale de la CxC y solo el excedente', async () => {
    build(venta({ payment: { method: 'credit' } }));
    const CLIENTE = new Types.ObjectId();
    cxc = { _id: new Types.ObjectId(), customerId: CLIENTE, amount: 40_000, paidAmount: 38_000, status: 'partial' };
    await service.create(saleId.toString(), devolucion({ refundMethod: 'credit_note' }), user);
    // Devuelve $15.000: $2.000 bajan la CxC y $13.000 quedan a favor.
    expect(saldoFavor.abonar).toHaveBeenCalledWith(expect.objectContaining({ customerId: CLIENTE, amount: 13_000 }));
  });

  it('venta fiada: baja primero la CxC y solo el resto sale por el medio', async () => {
    build(venta({ payment: { method: 'credit' } }));
    cxc = { _id: new Types.ObjectId(), amount: 40_000, paidAmount: 38_000, status: 'partial' };
    const r: any = await service.createRebaja(saleId.toString(), rebaja(), user);
    expect(r.abonoCartera).toBe(2_000);
    expect(caja.movement.mock.calls[0][0].amount).toBe(2_000);
    expect(ledger.postSaleReturn.mock.calls[0][0].toReceivable).toBe(2_000);
  });

  it('el tope es lo pagado menos lo devuelto y lo rebajado: 400 si pasa', async () => {
    build();
    await service.createRebaja(saleId.toString(), rebaja({ amount: 30_000 }), user);
    await expect(
      service.createRebaja(saleId.toString(), rebaja({ amount: 10_001, idempotencyKey: 'rebaja-0002' }), user),
    ).rejects.toThrow(/pasa de lo que queda/);
  });

  it('después de una rebaja, la devolución total devuelve solo lo que queda', async () => {
    build();
    await service.createRebaja(
      saleId.toString(),
      rebaja({ amount: undefined, lines: [{ productId: HAMB.toString(), amount: 6_000 }] }),
      user,
    );
    const d: any = await service.create(
      saleId.toString(),
      devolucion({ lines: [{ productId: HAMB.toString(), qty: 3 }] }),
      user,
    );
    // Pagó $30.000, se le rebajaron $6.000: vuelven $24.000, no $30.000.
    expect(d.refundTotal).toBe(24_000);
    const rebajado = registros.find((x) => x.kind === 'rebaja').lines[0].refundTax;
    expect(d.lines[0].refundTax + rebajado).toBe(2_222);
  });

  it('el reintento con la misma llave no rebaja dos veces; con otra carga es 409', async () => {
    build();
    const a: any = await service.createRebaja(saleId.toString(), rebaja(), user);
    const b: any = await service.createRebaja(saleId.toString(), rebaja(), user);
    expect(String(b._id)).toBe(String(a._id));
    expect(caja.movement).toHaveBeenCalledTimes(1);
    await expect(service.createRebaja(saleId.toString(), rebaja({ amount: 5_000 }), user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Una devolución con la llave de una rebaja tampoco pasa.
    await expect(
      service.create(saleId.toString(), devolucion({ idempotencyKey: 'rebaja-0001' }), user),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('si la nota falla, la rebaja se retira entera y no mueve caja ni libro', async () => {
    build();
    puerto.emitirNota.mockRejectedValueOnce(new ConflictException('tope'));
    await expect(service.createRebaja(saleId.toString(), rebaja(), user)).rejects.toThrow('tope');
    expect(registros).toHaveLength(0);
    expect(caja.movement).not.toHaveBeenCalled();
    expect(ledger.postSaleReturn).not.toHaveBeenCalled();
  });

  it('venta anulada, de plataforma o fiada a empleado: no admite rebaja', async () => {
    build(venta({ status: 'void' }));
    await expect(service.createRebaja(saleId.toString(), rebaja(), user)).rejects.toThrow(/anulada/);
    build(venta({ platform: { code: 'rappi' } }));
    await expect(service.createRebaja(saleId.toString(), rebaja(), user)).rejects.toThrow(/plataforma/);
    build(venta({ payment: { method: 'credit' } }));
    cxc = null;
    await expect(service.createRebaja(saleId.toString(), rebaja(), user)).rejects.toThrow(/empleado/);
  });
});
